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

type FleetSearchSource = "text" | "toolCall" | "toolResult" | "custom";
interface ContentLocation {
	blockIndex: number | null;
	field: string;
	argumentPath?: (string | number)[];
}

export interface FleetSearchPage {
	hits: Array<{
		id: string; timestamp: string; role: string; source: FleetSearchSource; snippet: string; sequence: number;
		toolName?: string; toolCallId?: string;
		match?: ContentLocation & { start: number; end: number; contentCursor: string };
	}>;
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
	roles?: unknown;
	toolNames?: unknown;
	sources?: unknown;
	fields?: unknown;
	snapshotLeafId?: unknown;
	searchOrder?: unknown;
	searchBefore?: unknown;
}

export interface FleetMessageOptions {
	messageId: unknown;
	before?: unknown;
	after?: unknown;
	leafId?: unknown;
	toolCallId?: unknown;
	contentCursor?: unknown;
}

export interface FleetMessageContext {
	anchorId: string;
	leafId: string | null;
	messages: Array<FleetMessagePage["messages"][number] & { contentCursor?: string }>;
	relatedIds: string[];
	contextTruncated?: true;
	content?: ContentLocation & { messageId: string; value: unknown; offset: number; nextCursor: string | null;
		toolName?: string; toolCallId?: string };
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
	query?: string; from?: number; to?: number; cursor?: string; limit: number;
	roles?: string[]; toolNames?: string[]; sources?: string[]; fields?: string[];
	snapshotLeafId?: string | null; searchOrder?: "timestamp"; searchBefore?: { timestamp: number; sequence: number };
} {
	const { query, limit = 20 } = options;
	const optional = (value: unknown): unknown => typeof value === "string" ? value.trim() || undefined : value;
	const from = optional(options.from);
	const to = optional(options.to);
	const cursor = optional(options.cursor);
	if (query !== undefined && (typeof query !== "string" || !query.trim() || query.trim().length > 256)) {
		throw new Error("query must be between 1 and 256 characters");
	}
	const timestamp = (value: unknown, field: string): number | undefined => {
		if (value === undefined) return undefined;
		const parts = typeof value === "string" &&
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
		const error = `${field} must be an ISO-8601 timestamp with timezone, e.g. 2026-09-30T00:00:00Z; omit it for no time bound`;
		if (!parts) throw new Error(error);
		const [, year, month, day, hours, minutes, seconds, , offsetHour, offsetMinute] = parts;
		const calendar = new Date(0);
		calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
		if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) ||
			calendar.getUTCDate() !== Number(day) || Number(hours) > 23 || Number(minutes) > 59 ||
			Number(seconds) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) {
			throw new Error(error);
		}
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed)) throw new Error(error);
		return parsed;
	};
	const start = timestamp(from, "from");
	const end = timestamp(to, "to");
	if (query === undefined && start === undefined && end === undefined) throw new Error("query, from, or to is required");
	if (start !== undefined && end !== undefined && start >= end) throw new Error("from must be before to");
	if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error("limit must be between 1 and 50");
	if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 128)) {
		throw new Error("cursor must be a returned nextCursor (1–128 characters); omit it to start at the newest matches");
	}
	const list = (value: unknown, field: string): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
			value.some(item => typeof item !== "string" || !item.trim() || item.length > 128)) {
			throw new Error(`${field} must be a nonempty array of up to 32 strings (1–128 characters each)`);
		}
		return [...new Set(value.map(item => (item as string).trim()))];
	};
	const roles = list(options.roles, "roles");
	const toolNames = list(options.toolNames, "toolNames");
	const sources = list(options.sources, "sources");
	const fields = list(options.fields, "fields");
	if (sources?.some(source => !["text", "toolCall", "toolResult", "custom"].includes(source))) {
		throw new Error("sources must contain text, toolCall, toolResult, or custom");
	}
	if (fields?.some(field => !["text", "toolResult", "custom", "toolCall.arguments"].includes(field) &&
		!/^toolCall\.arguments(?:\.[^.\s]+)+$/.test(field))) {
		throw new Error("fields must contain text, toolResult, custom, or toolCall.arguments with an optional dotted path");
	}
	const snapshotLeafId = options.snapshotLeafId;
	if (snapshotLeafId !== undefined && snapshotLeafId !== null) validateMessageId(snapshotLeafId, "snapshotLeafId");
	if (options.searchOrder !== undefined && options.searchOrder !== "timestamp") throw new Error("searchOrder must be timestamp");
	let searchBefore: { timestamp: number; sequence: number } | undefined;
	if (options.searchBefore !== undefined) {
		const boundary = options.searchBefore as { timestamp?: unknown; sequence?: unknown } | null;
		if (!boundary || typeof boundary !== "object" || !Number.isSafeInteger(boundary.sequence) ||
			(boundary.sequence as number) < -1) throw new Error("searchBefore requires a timestamp and a safe integer sequence >= -1");
		const when = timestamp(boundary.timestamp, "searchBefore.timestamp");
		if (when === undefined) throw new Error("searchBefore.timestamp is required");
		searchBefore = { timestamp: when, sequence: boundary.sequence as number };
		if (options.searchOrder !== "timestamp") throw new Error("searchBefore requires timestamp searchOrder");
	}
	return { ...(query === undefined ? {} : { query: query.trim().toLowerCase() }), from: start, to: end,
		...(cursor === undefined ? {} : { cursor: cursor as string }), limit: limit as number,
		roles, toolNames, sources, fields, ...(snapshotLeafId === undefined ? {} : { snapshotLeafId: snapshotLeafId as string | null }),
		...(options.searchOrder === undefined ? {} : { searchOrder: "timestamp" }), searchBefore };
}

function validateMessageId(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !value || value.length > 128) throw new Error(`${field} must be a message id (1–128 characters)`);
}

function visibleEntry(entry: FleetBranchEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" && entry.display !== false;
}

function entryRole(entry: FleetBranchEntry): string {
	return entry.type === "custom_message" ? "custom" : entry.message?.role ?? "unknown";
}

interface VisiblePart extends ContentLocation {
	value: unknown;
	source: FleetSearchSource;
	toolName?: string;
	toolCallId?: string;
}

/** Walk leaves lazily, preserving array indices and keys without serializing giant arguments. */
function* argumentLeaves(value: unknown, path: (string | number)[] = []): Generator<{ value: unknown; path: (string | number)[] }> {
	const children = function* (object: object): Generator<[string | number, unknown]> {
		if (Array.isArray(object)) {
			for (let index = 0; index < object.length; index++) yield [index, object[index]];
		} else {
			for (const key in object) if (Object.hasOwn(object, key)) yield [key, (object as Record<string, unknown>)[key]];
		}
	};
	const stack: Array<{ value: unknown; path: (string | number)[]; iterator?: Generator<[string | number, unknown]> }> = [{ value, path }];
	while (stack.length) {
		const frame = stack.at(-1)!;
		if (frame.value === null || typeof frame.value !== "object") {
			stack.pop();
			if (frame.value !== undefined) yield { value: frame.value, path: frame.path };
			continue;
		}
		if (!frame.iterator) {
			frame.iterator = children(frame.value);
			const first = frame.iterator.next();
			if (first.done) { stack.pop(); yield { value: frame.value, path: frame.path }; continue; }
			stack.push({ value: first.value[1], path: [...frame.path, first.value[0]] });
			continue;
		}
		const child = frame.iterator.next();
		if (child.done) stack.pop();
		else stack.push({ value: child.value[1], path: [...frame.path, child.value[0]] });
	}
}

/** The only stream used by search and continuation: never thinking, images, or hidden custom entries. */
function* visibleContent(entry: FleetBranchEntry): Generator<VisiblePart> {
	if (!visibleEntry(entry)) return;
	const role = entryRole(entry);
	const source: FleetSearchSource = role === "custom" ? "custom" : role === "toolResult" ? "toolResult" : "text";
	const metadata = {
		...(entry.message?.toolName ? { toolName: entry.message.toolName } : {}),
		...(entry.message?.toolCallId ? { toolCallId: entry.message.toolCallId } : {}),
	};
	const content = entry.type === "custom_message" ? entry.content : entry.message?.content;
	if (typeof content === "string") { yield { value: content, source, field: source, blockIndex: null, ...metadata }; return; }
	if (!Array.isArray(content)) return;
	for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
		const block = content[blockIndex];
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			yield { value: block.text, source, field: source, blockIndex, ...metadata };
		} else if (block.type === "toolCall") {
			for (const leaf of argumentLeaves(block.arguments)) yield {
				value: leaf.value, source: "toolCall", field: "toolCall.arguments", argumentPath: leaf.path, blockIndex,
				...(typeof block.name === "string" ? { toolName: block.name } : {}),
				...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
			};
		}
	}
}

interface ContentCursor {
	version: 1; messageId: string; leafId: string | null; part: number; offset: number;
}

function contentCursor(messageId: string, leafId: string | null, part: number, offset = 0): string {
	return Buffer.from(JSON.stringify({ version: 1, messageId, leafId, part, offset })).toString("base64url");
}

function parseContentCursor(value: unknown): ContentCursor {
	if (typeof value !== "string" || value.length > 2048 || !/^[\w-]+$/.test(value)) throw new Error("invalid contentCursor");
	let parsed: unknown;
	try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("invalid contentCursor"); }
	if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 ||
		!("messageId" in parsed) || typeof parsed.messageId !== "string" || !parsed.messageId || parsed.messageId.length > 128 ||
		!("leafId" in parsed) || !(parsed.leafId === null || typeof parsed.leafId === "string" && parsed.leafId.length <= 128) ||
		!("part" in parsed) || typeof parsed.part !== "number" || !Number.isSafeInteger(parsed.part) || parsed.part < 0 ||
		!("offset" in parsed) || typeof parsed.offset !== "number" || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
		throw new Error("invalid contentCursor");
	}
	return { version: 1, messageId: parsed.messageId, leafId: parsed.leafId, part: parsed.part, offset: parsed.offset };
}

function snapshotBranch(manager: FleetBranchManager, leafId: string | null | undefined, kind: string): { branch: FleetBranchEntry[]; leafId: string | null } {
	const branch = manager.getBranch();
	if (leafId === undefined) return { branch, leafId: manager.getLeafId() };
	if (leafId === null) return { branch: [], leafId: null };
	const index = branch.findLastIndex(entry => entry.id === leafId);
	if (index < 0) throw new Error(`${kind} is not on the active branch`);
	return { branch: branch.slice(0, index + 1), leafId };
}

/** A short one-line preview centered at the first literal match. */
function searchSnippet(text: string, match: number): string {
	const start = match < 0 ? 0 : Math.max(0, match - 80);
	return text.slice(start, start + 200).replace(/\s+/g, " ").trim();
}

/** Newest matching entries are paged first; returned hits remain chronological. */
export function searchFleetMessages(manager: FleetBranchManager, options: FleetSearchOptions): FleetSearchPage {
	const { query, from, to, cursor, limit, roles, toolNames, sources, fields, snapshotLeafId, searchOrder, searchBefore } = validateFleetSearch(options);
	// Case-fold only in the matcher: Unicode lowercasing can expand the literal and change its UTF-16 length.
	const literal = query === undefined ? undefined : (options.query as string).trim();
	const pattern = literal === undefined ? undefined : new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	const { branch, leafId } = snapshotBranch(manager, snapshotLeafId, "search snapshot");
	const end = cursor === undefined ? branch.length : branch.findLastIndex(entry => entry.id === cursor);
	if (end < 0) throw new Error("cursor is not on the active branch");
	const hits: FleetSearchPage["hits"] = [];
	const compare = (a: FleetSearchPage["hits"][number], b: FleetSearchPage["hits"][number]): number =>
		Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence;
	let hasMore = false;
	for (let index = end - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (!visibleEntry(entry)) continue;
		const when = Date.parse(entry.timestamp);
		if (searchOrder === "timestamp" && !Number.isFinite(when)) continue;
		if (from !== undefined && !(when >= from) || to !== undefined && !(when < to)) continue;
		if (searchBefore && (when > searchBefore.timestamp || when === searchBefore.timestamp && index >= searchBefore.sequence)) continue;
		const role = entryRole(entry);
		if (roles && !roles.includes(role)) continue;
		let found: { part: VisiblePart; ordinal: number; index: number } | undefined;
		let ordinal = 0;
		for (const part of visibleContent(entry)) {
			const current = ordinal++;
			if (toolNames && (!part.toolName || !toolNames.includes(part.toolName))) continue;
			if (sources && !sources.includes(part.source)) continue;
			if (fields) {
				const dotted = [part.field, ...(part.argumentPath ?? []).map(String)].join(".");
				if (!fields.some(field => dotted === field || dotted.startsWith(`${field}.`))) continue;
			}
			const match = pattern === undefined ? 0 : typeof part.value === "string" ? pattern.exec(part.value)?.index ?? -1 : -1;
			if (match >= 0) { found = { part, ordinal: current, index: match }; break; }
		}
		if (!found && (query !== undefined || toolNames || sources || fields)) continue;
		const source = found?.part.source ?? (role === "custom" ? "custom" : role === "toolResult" ? "toolResult" : "text");
		const hit: FleetSearchPage["hits"][number] = {
			id: entry.id, timestamp: entry.timestamp, role, source, sequence: index,
			snippet: found && typeof found.part.value === "string" ? searchSnippet(found.part.value, found.index) : "",
			...(found?.part.toolName ?? entry.message?.toolName ? { toolName: found?.part.toolName ?? entry.message?.toolName } : {}),
			...(found?.part.toolCallId ?? entry.message?.toolCallId ? { toolCallId: found?.part.toolCallId ?? entry.message?.toolCallId } : {}),
			...(found ? { match: {
				blockIndex: found.part.blockIndex, field: found.part.field,
				...(found.part.argumentPath === undefined ? {} : { argumentPath: found.part.argumentPath }),
				start: found.index, end: found.index + (literal?.length ?? 0),
				contentCursor: contentCursor(entry.id, leafId, found.ordinal, Math.max(0, found.index - 80)),
			} } : {}),
		};
		if (searchOrder === "timestamp") {
			let low = 0;
			let high = hits.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (compare(hits[middle]!, hit) < 0) low = middle + 1;
				else high = middle;
			}
			hits.splice(low, 0, hit);
			if (hits.length > limit) { hits.shift(); hasMore = true; }
		} else {
			if (hits.length >= limit) { hasMore = true; break; }
			hits.push(hit);
		}
	}
	if (searchOrder !== "timestamp") hits.reverse();
	return { hits, nextCursor: hits[0]?.id ?? cursor ?? null, hasMore, leafId };
}

const MAX_BLOCKS = 12;
const MAX_TEXT_CHARS = 2000;
const MAX_PAGE_CHARS = 60_000;
const CONTENT_CHUNK_CHARS = 8000;

/** Stop JSON traversal before a large value is serialized; small arguments retain their structured shape. */
function smallArguments(value: unknown): boolean {
	let remaining = MAX_TEXT_CHARS;
	const oversized = Symbol("oversized");
	try {
		const serialized = JSON.stringify(value, function (this: unknown, key, item) {
			if (key.length > remaining || typeof item === "string" && item.length > remaining) throw oversized;
			// Count a lower bound (commas omitted), so no argument that fits the legacy budget is rejected.
			if (key && !Array.isArray(this) && item !== undefined) remaining -= JSON.stringify(key).length + 1;
			remaining -= item !== null && typeof item === "object" ? 2 : JSON.stringify(item)?.length ?? 0;
			if (remaining < 0) throw oversized;
			return item;
		});
		return serialized !== undefined && serialized.length <= MAX_TEXT_CHARS;
	} catch (error) {
		if (error === oversized) return false;
		throw error;
	}
}

/** Project SDK content without forwarding inline images or unbounded tool output. */
function boundedContent(content: unknown, hideThinking = false): { value: unknown; truncated: boolean } {
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
		} else if (type === "text" || !hideThinking && type === "thinking") {
			if (!("text" in block) || typeof block.text !== "string") continue;
			blocks.push({ type, text: block.text.slice(0, MAX_TEXT_CHARS) });
			if (block.text.length > MAX_TEXT_CHARS) truncated = true;
		} else if (type === "toolCall") {
			const call: Record<string, unknown> = { type };
			if ("id" in block && typeof block.id === "string") call.id = block.id;
			if ("name" in block && typeof block.name === "string") call.name = block.name;
			if ("arguments" in block) {
				if (smallArguments(block.arguments)) call.arguments = block.arguments;
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

function projectedMessage(entry: FleetBranchEntry, hideThinking = false): FleetMessagePage["messages"][number] {
	const message = entry.message;
	const content = boundedContent(entry.type === "custom_message" ? entry.content : message?.content, hideThinking);
	return {
		id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, role: entryRole(entry), content: content.value,
		...(content.truncated ? { truncated: true } : {}),
		...(message?.toolName ? { toolName: message.toolName } : {}),
		...(message?.toolCallId ? { toolCallId: message.toolCallId } : {}),
		...(message?.isError !== undefined ? { isError: message.isError } : {}),
		...(message?.stopReason ? { stopReason: message.stopReason } : {}),
		...(message?.errorMessage ? { errorMessage: message.errorMessage.slice(0, MAX_TEXT_CHARS) } : {}),
	};
}

function* entryToolCallIds(entry: FleetBranchEntry): Generator<string> {
	if (entry.message?.role === "toolResult" && entry.message.toolCallId) yield entry.message.toolCallId;
	if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return;
	for (const block of entry.message.content) {
		if (block?.type === "toolCall" && typeof block.id === "string") yield block.id;
	}
}

/** Inclusive visible context and ID-based tool pairing, frozen to an active ancestor. */
export function getFleetMessage(manager: FleetBranchManager, options: FleetMessageOptions): FleetMessageContext {
	validateMessageId(options.messageId, "messageId");
	const count = (value: unknown, fallback: number, field: string): number => {
		if (value === undefined) return fallback;
		if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10) throw new Error(`${field} must be between 0 and 10`);
		return value as number;
	};
	const before = count(options.before, 1, "before");
	const after = count(options.after, 2, "after");
	if (options.leafId !== undefined) validateMessageId(options.leafId, "leafId");
	if (options.toolCallId !== undefined) validateMessageId(options.toolCallId, "toolCallId");
	const continuation = options.contentCursor === undefined ? undefined : parseContentCursor(options.contentCursor);
	if (continuation && (continuation.messageId !== options.messageId ||
		options.leafId !== undefined && continuation.leafId !== options.leafId)) throw new Error("contentCursor does not belong to this message snapshot");
	const { branch, leafId } = snapshotBranch(manager, continuation ? continuation.leafId : options.leafId as string | undefined, "message snapshot");
	const visible = branch.filter(visibleEntry);
	const anchorIndex = visible.findIndex(entry => entry.id === options.messageId);
	if (anchorIndex < 0) throw new Error("message is not visible on the active branch");
	const anchor = visible[anchorIndex]!;
	const toolIds = new Set(entryToolCallIds(anchor));
	if (options.toolCallId !== undefined) {
		if (!toolIds.has(options.toolCallId as string)) throw new Error("toolCallId does not belong to the anchor");
		toolIds.clear();
		toolIds.add(options.toolCallId as string);
	}
	const related = visible.filter(entry => {
		if (entry.id === anchor.id || toolIds.size === 0) return false;
		for (const id of entryToolCallIds(entry)) if (toolIds.has(id)) return true;
		return false;
	});
	const requested = new Set(visible.slice(Math.max(0, anchorIndex - before), anchorIndex + after + 1));
	for (const entry of related) requested.add(entry);
	const result: FleetMessageContext = { anchorId: anchor.id, leafId, messages: [], relatedIds: related.map(entry => entry.id) };
	if (continuation) {
		const iterator = visibleContent(anchor);
		let current = iterator.next();
		for (let index = 0; index < continuation.part && !current.done; index++) current = iterator.next();
		if (current.done || (typeof current.value.value === "string" ? continuation.offset > current.value.value.length : continuation.offset !== 0)) {
			throw new Error("contentCursor is outside visible content");
		}
		const part = current.value;
		const value = typeof part.value === "string" ? part.value.slice(continuation.offset, continuation.offset + CONTENT_CHUNK_CHARS) : part.value;
		const nextOffset = typeof value === "string" ? continuation.offset + value.length : 0;
		const within = typeof part.value === "string" && nextOffset < part.value.length;
		const next = within ? contentCursor(anchor.id, leafId, continuation.part, nextOffset) :
			iterator.next().done ? null : contentCursor(anchor.id, leafId, continuation.part + 1);
		result.content = {
			messageId: anchor.id, blockIndex: part.blockIndex, field: part.field,
			...(part.argumentPath === undefined ? {} : { argumentPath: part.argumentPath }),
			...(part.toolName === undefined ? {} : { toolName: part.toolName }),
			...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
			value, offset: continuation.offset, nextCursor: next,
		};
	}
	const rows = new Map<FleetBranchEntry, FleetMessageContext["messages"][number]>();
	let usedChars = result.content ? JSON.stringify(result.content).length : 0;
	// The anchor has priority over context or pairs, even if its bounded projection exhausts the budget.
	for (const entry of [anchor, ...requested]) {
		if (rows.has(entry)) continue;
		const row: FleetMessageContext["messages"][number] = projectedMessage(entry, true);
		if (!visibleContent(entry).next().done) row.contentCursor = contentCursor(entry.id, leafId, 0);
		const size = JSON.stringify(row).length;
		if (entry !== anchor && usedChars + size > MAX_PAGE_CHARS) { result.contextTruncated = true; continue; }
		rows.set(entry, row);
		usedChars += size;
		if (usedChars > MAX_PAGE_CHARS) result.contextTruncated = true;
	}
	for (const entry of visible) {
		const row = rows.get(entry);
		if (row) result.messages.push(row);
	}
	return result;
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
		const row = projectedMessage(entry);
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
