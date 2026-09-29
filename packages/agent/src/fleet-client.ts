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
	nextCursor: string | null;
	hasMore: boolean;
	leafId: string | null;
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

/** Page active-branch messages; rewinding past a cursor is an explicit conflict. */
export function pageFleetMessages(
	manager: { getBranch(): Array<{ id: string; parentId: string | null; timestamp: string; type: string;
		message?: { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean;
			stopReason?: string; errorMessage?: string }; content?: unknown; display?: boolean }>; getLeafId(): string | null },
	cursor?: string,
	limit = 50,
): FleetMessagePage {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
	const branch = manager.getBranch();
	const start = cursor === undefined ? 0 : branch.findIndex(entry => entry.id === cursor) + 1;
	if (cursor !== undefined && start === 0) throw new Error("cursor is not on the active branch");
	const messages: FleetMessagePage["messages"] = [];
	let usedChars = 0;
	let hasMore = false;
	for (let index = start; index < branch.length; index++) {
		const entry = branch[index]!;
		if (entry.type !== "message" && (entry.type !== "custom_message" || entry.display === false)) continue;
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
		if (messages.length >= limit || (messages.length > 0 && usedChars + size > MAX_PAGE_CHARS)) {
			hasMore = true;
			break;
		}
		messages.push(row);
		usedChars += size;
	}
	return { messages, nextCursor: messages.at(-1)?.id ?? cursor ?? null, hasMore, leafId: manager.getLeafId() };
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
