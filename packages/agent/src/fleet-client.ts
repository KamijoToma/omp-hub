/**
 * Child-side fleet IPC client (protocol 0.8.0 `fleet-req`/`fleet-res`).
 *
 * A superagent session's fleet tools call the hub API through the parent
 * daemon (which holds `HUB_TOKEN`): each request is one JSONL frame on stdout,
 * correlated back by `reqId`. The child abandons an unanswered request after
 * 30 s; late or unknown-`reqId` replies are dropped.
 */

import { randomBytes } from "node:crypto";

/** One proxied hub call: exactly one of the two shapes. */
export type FleetResult = { ok: true; status: number; body?: unknown } | { ok: false; error: string };
export interface FleetMessagePage {
	messages: Array<{
		id: string;
		parentId: string | null;
		timestamp: string;
		role: string;
		content: unknown;
		truncated?: true;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
		stopReason?: string;
		errorMessage?: string;
	}>;
	/** Oldest returned message id; pass it as `cursor` to read strictly earlier history. */
	nextCursor: string | null;
	hasMore: boolean;
	leafId: string | null;
}

export interface FleetSearchPage {
	hits: Array<{ id: string; timestamp: string; role: string; source: "text" | "toolCall" | "toolResult" | "custom"; snippet: string; toolName?: string }>;
	nextCursor: string | null;
	hasMore: boolean;
	leafId: string | null;
}

export interface FleetSearchOptions {
	query?: unknown;
	from?: unknown;
	to?: unknown;
	cursor?: unknown;
	limit?: unknown;
}

export interface FleetBranchEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	message?: { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean;
		stopReason?: string; errorMessage?: string };
	content?: unknown;
	display?: boolean;
}

export interface FleetBranchManager {
	getBranch(): FleetBranchEntry[];
	getLeafId(): string | null;
}

/** Strict wire validation shared by live and stored-history commands. */
export function validateFleetSearch(options: FleetSearchOptions): {
	query?: string; from?: number; to?: number; cursor?: string; limit: number
} {
	const { query, from, to, cursor, limit = 20 } = options;
	if (query !== undefined && (typeof query !== "string" || !query.trim() || query.trim().length > 256)) {
		throw new Error("query must be between 1 and 256 characters");
	}
	const timestamp = (value: unknown, field: string): number | undefined => {
		if (value === undefined) return undefined;
		const parts = typeof value === "string" &&
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
		if (!parts) throw new Error(`${field} must be an ISO-8601 timestamp with timezone`);
		const [, year, month, day, hours, minutes, seconds, , offsetHour, offsetMinute] = parts;
		const calendar = new Date(0);
		calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
		if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) ||
			calendar.getUTCDate() !== Number(day) || Number(hours) > 23 || Number(minutes) > 59 ||
			Number(seconds) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) {
			throw new Error(`${field} must be an ISO-8601 timestamp with timezone`);
		}
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO-8601 timestamp with timezone`);
		return parsed;
	};
	const start = timestamp(from, "from");
	const end = timestamp(to, "to");
	if (query === undefined && start === undefined && end === undefined) throw new Error("query, from, or to is required");
	if (start !== undefined && end !== undefined && start >= end) throw new Error("from must be before to");
	if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error("limit must be between 1 and 50");
	if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 128)) {
		throw new Error("cursor must be between 1 and 128 characters");
	}
	return { ...(query === undefined ? {} : { query: query.trim().toLowerCase() }), from: start, to: end,
		...(cursor === undefined ? {} : { cursor: cursor as string }), limit: limit as number };
}

/** Search source strings in SDK block order, never projecting hidden or binary blocks. */
function* searchableContent(content: unknown): Generator<{ text: string; source: "text" | "toolCall"; toolName?: string }> {
	if (typeof content === "string") { yield { text: content, source: "text" }; return; }
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") yield { text: block.text, source: "text" };
		if (block.type !== "toolCall") continue;
		// The arguments are stored structured data, not the 2k text projected by
		// fleet_get_messages. Scan nested string values without serializing the object.
		const stack: unknown[] = [block.arguments];
		while (stack.length) {
			const value = stack.pop();
			if (typeof value === "string") yield { text: value, source: "toolCall",
				...(typeof block.name === "string" ? { toolName: block.name } : {}) };
			else if (value && typeof value === "object") {
				const values = Object.values(value);
				for (let index = values.length - 1; index >= 0; index--) stack.push(values[index]);
			}
		}
	}
}

/** A short one-line preview centered at the first literal match. */
function searchSnippet(text: string, match: number): string {
	const start = match < 0 ? 0 : Math.max(0, match - 80);
	return text.slice(start, start + 200).replace(/\s+/g, " ").trim();
}

/** Newest matching entries are paged first; returned hits remain chronological. */
export function searchFleetMessages(manager: FleetBranchManager, options: FleetSearchOptions): FleetSearchPage {
	const { query, from, to, cursor, limit } = validateFleetSearch(options);
	const pattern = query === undefined ? undefined : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	const branch = manager.getBranch();
	const end = cursor === undefined ? branch.length : branch.findLastIndex(entry => entry.id === cursor);
	if (end < 0) throw new Error("cursor is not on the active branch");
	const hits: FleetSearchPage["hits"] = [];
	let hasMore = false;
	for (let index = end - 1; index >= 0; index--) {
		const entry: FleetBranchEntry = branch[index]!;
		if (entry.type !== "message" && (entry.type !== "custom_message" || entry.display === false)) continue;
		if (from !== undefined || to !== undefined) {
			const when = Date.parse(entry.timestamp);
			if (from !== undefined && !(when >= from) || to !== undefined && !(when < to)) continue;
		}
		const message = entry.message;
		const role = entry.type === "custom_message" ? "custom" : message?.role ?? "unknown";
		const content = entry.type === "custom_message" ? entry.content : message?.content;
		let found: { text: string; source: "text" | "toolCall"; toolName?: string; index: number } | undefined;
		for (const part of searchableContent(content)) {
			const match = pattern === undefined ? 0 : pattern.exec(part.text)?.index ?? -1;
			if (match >= 0) { found = { ...part, index: match }; break; }
		}
		if (query !== undefined && !found) continue;
		if (hits.length >= limit) { hasMore = true; break; }
		const source = entry.type === "custom_message" ? "custom" :
			role === "toolResult" ? "toolResult" : found?.source ?? "text";
		hits.push({
			id: entry.id, timestamp: entry.timestamp, role, source,
			snippet: found ? searchSnippet(found.text, found.index) : "",
			...(found?.toolName || message?.toolName ? { toolName: found?.toolName ?? message?.toolName } : {}),
		});
	}
	hits.reverse();
	return { hits, nextCursor: hits[0]?.id ?? cursor ?? null, hasMore, leafId: manager.getLeafId() };
}

const MAX_BLOCKS = 12;
const MAX_TEXT_CHARS = 2000;
const MAX_PAGE_CHARS = 60_000;

/** Project SDK content without forwarding inline images or unbounded tool output. */
function boundedContent(content: unknown): { value: unknown; truncated: boolean } {
	if (typeof content === "string") {
		return { value: content.slice(0, MAX_TEXT_CHARS), truncated: content.length > MAX_TEXT_CHARS };
	}
	if (!Array.isArray(content)) return { value: null, truncated: false };
	let truncated = content.length > MAX_BLOCKS;
	const blocks: Array<Record<string, unknown>> = [];
	for (const block of content.slice(0, MAX_BLOCKS)) {
		if (typeof block !== "object" || block === null || !("type" in block) || typeof block.type !== "string") continue;
		const type = block.type;
		if (type === "image") {
			blocks.push({ type, ...( "mimeType" in block && typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}), omitted: true });
			truncated = true;
		} else if (type === "text" || type === "thinking") {
			if (!("text" in block) || typeof block.text !== "string") continue;
			blocks.push({ type, text: block.text.slice(0, MAX_TEXT_CHARS) });
			if (block.text.length > MAX_TEXT_CHARS) truncated = true;
		} else if (type === "toolCall") {
			const call: Record<string, unknown> = { type };
			if ("id" in block && typeof block.id === "string") call.id = block.id;
			if ("name" in block && typeof block.name === "string") call.name = block.name;
			if ("arguments" in block) {
				const serialized = JSON.stringify(block.arguments);
				if (serialized !== undefined && serialized.length <= MAX_TEXT_CHARS) call.arguments = block.arguments;
				else { call.arguments = "[omitted: large tool arguments]"; truncated = true; }
			}
			blocks.push(call);
		} else {
			blocks.push({ type, omitted: true });
			truncated = true;
		}
	}
	return { value: blocks, truncated };
}

/** Page the active branch from its newest messages; a rewound cursor is an explicit conflict. */
export function pageFleetMessages(
	manager: FleetBranchManager,
	cursor?: string,
	limit = 20,
): FleetMessagePage {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
	const branch = manager.getBranch();
	const end = cursor === undefined ? branch.length : branch.findLastIndex(entry => entry.id === cursor);
	if (end < 0) throw new Error("cursor is not on the active branch");
	const messages: FleetMessagePage["messages"] = [];
	let usedChars = 0;
	let hasMore = false;
	for (let index = end - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" && (entry.type !== "custom_message" || entry.display === false)) continue;
		if (messages.length >= limit) {
			hasMore = true;
			break;
		}
		const message = entry.message;
		const content = boundedContent(entry.type === "custom_message" ? entry.content : message?.content);
		const row: FleetMessagePage["messages"][number] = {
			id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
			role: entry.type === "custom_message" ? "custom" : message?.role ?? "unknown",
			content: content.value,
			...(content.truncated ? { truncated: true } : {}),
			...(message?.toolName ? { toolName: message.toolName } : {}),
			...(message?.toolCallId ? { toolCallId: message.toolCallId } : {}),
			...(message?.isError !== undefined ? { isError: message.isError } : {}),
			...(message?.stopReason ? { stopReason: message.stopReason } : {}),
			...(message?.errorMessage ? { errorMessage: message.errorMessage.slice(0, MAX_TEXT_CHARS) } : {}),
		};
		const size = JSON.stringify(row).length;
		if (messages.length > 0 && usedChars + size > MAX_PAGE_CHARS) {
			hasMore = true;
			break;
		}
		messages.push(row);
		usedChars += size;
	}
	messages.reverse();
	return { messages, nextCursor: messages[0]?.id ?? cursor ?? null, hasMore, leafId: manager.getLeafId() };
}

/** Unanswered `fleet-req`s the client still owes a tool. */
interface PendingFleetRequest {
	resolve(result: FleetResult): void;
	timer: Timer;
}

/** Child abandons an unanswered `fleet-req` after this long (protocol 0.8.0). */
const FLEET_TIMEOUT_MS = 30_000;

export interface FleetClient {
	request(method: string, path: string, body?: unknown): Promise<FleetResult>;
	handleFrame(frame: unknown): void;
}

let fleetReqCounter = 0;

/** `f_` + counter + randomness: no collision across concurrent calls. */
function nextFleetReqId(): string {
	fleetReqCounter += 1;
	return `f_${fleetReqCounter}_${randomBytes(6).toString("hex")}`;
}

/**
 * Create the child-side fleet client. `write` is the raw stdout frame writer
 * (the same channel `ready`/`cmd-result` use); it must stay JSONL-clean.
 */
export function createFleetClient(write: (line: string) => void, log?: { warn(message: string): void }): FleetClient {
	const pending = new Map<string, PendingFleetRequest>();

	const settle = (reqId: string, result: FleetResult): void => {
		const entry = pending.get(reqId);
		if (!entry) {
			// Late reply after the tool's 30 s timeout, or a foreign reqId.
			log?.warn(`dropping fleet-res for unknown reqId ${reqId}`);
			return;
		}
		pending.delete(reqId);
		clearTimeout(entry.timer);
		entry.resolve(result);
	};

	return {
		request(method, path, body) {
			const reqId = nextFleetReqId();
			const { promise, resolve } = Promise.withResolvers<FleetResult>();
			const timer = setTimeout(() => settle(reqId, { ok: false, error: "fleet: request timeout" }), FLEET_TIMEOUT_MS);
			// Never hold the child open for an abandoned request.
			timer.unref?.();
			pending.set(reqId, { resolve, timer });
			write(`${JSON.stringify({ t: "fleet-req", reqId, method, path, ...(body === undefined ? {} : { body }) })}\n`);
			return promise;
		},
		handleFrame(frame) {
			if (typeof frame !== "object" || frame === null) return;
			const parsed = frame as { t?: unknown; reqId?: unknown; ok?: unknown };
			if (parsed.t !== "fleet-res") return;
			const reqId = typeof parsed.reqId === "string" ? parsed.reqId : "";
			if (!reqId) return;
			if (parsed.ok === true) {
				const result = parsed as { status?: unknown; body?: unknown };
				settle(reqId, {
					ok: true,
					status: typeof result.status === "number" ? result.status : 0,
					...(result.body === undefined ? {} : { body: result.body }),
				});
			} else {
				const error =
					typeof (parsed as { error?: unknown }).error === "string"
						? (parsed as { error: string }).error
						: "fleet: request failed";
				settle(reqId, { ok: false, error });
			}
		},
	};
}
