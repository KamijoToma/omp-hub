import { newCmdReqId, supportsFleetMessageSearch, supportsFleetSearchContext, type CmdRequest } from "./agents";
import type { ApiContext } from "./api";
import type { FleetState } from "./fleet-state";
import { isTerminalStatus, randomId, type SessionRecord } from "./sessions";

const FILTERS = ["roles", "toolNames", "sources", "fields"] as const;
const SEARCH_KEYS = ["query", "from", "to", "cursor", "limit", ...FILTERS];
const CURSOR_TTL_MS = 5 * 60_000;
const MAX_CURSORS = 256;
const MAX_CURSOR_PARTICIPANTS = 100_000;
const FANOUT = 8;
/** Leave time for the daemon's 15 s HTTP proxy to receive and decode partial results. */
const SEARCH_TIMEOUT_MS = 10_000;

type FailureReason = "offline" | "unsupported" | "history_unavailable" | "timeout" | "worker_error";
interface Participant {
	id: string;
	machineId: string;
	version: number;
	leafId?: string | null;
	failure?: FailureReason;
}
interface Boundary { timestamp: string; sessionId: string; sequence: number }
interface CursorState {
	ownerId: string;
	ownerVersion: number;
	namespaceId: string;
	binding: string;
	participants: Participant[];
	before: Boundary;
	expiresAt: number;
}
interface CursorStore { entries: Map<string, CursorState>; participants: number }
const cursorStores = new WeakMap<FleetState, CursorStore>();
interface SearchOptions {
	query?: string;
	from?: string;
	to?: string;
	cursor?: string;
	limit: number;
	roles?: string[];
	toolNames?: string[];
	sources?: string[];
	fields?: string[];
	sessionIds?: string[];
	machineIds?: string[];
	cwd?: string;
}
interface PublicHit {
	id: string;
	timestamp: string;
	sessionId: string;
	sequence?: number;
	role: string;
	source: string;
	snippet: string;
	toolName?: string;
	toolCallId?: string;
	match?: unknown;
}
type Hit = PublicHit & Boundary;
interface LegacySearchPage { hits: PublicHit[]; hasMore: boolean; nextCursor: string | null; leafId: string | null }
interface SearchPage { hits: Hit[]; hasMore: boolean; nextCursor: string | null; leafId: string | null }

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}
function fail(message: string, status = 400): never {
	throw new PublicError(message, status);
}
class PublicError extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}
function failureResponse(error: unknown): Response {
	return error instanceof PublicError ? json({ error: error.message }, error.status) : json({ error: "fleet search failed" }, 502);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid json body");
	return value as Record<string, unknown>;
}
function timestamp(value: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
	if (month < 1 || month > 12 || day < 1 || day > days) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}
function optionalString(value: unknown, name: string, max: number, blankOmitted = false): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") fail(name === "cursor"
		? "cursor must be a returned nextCursor; omit it to start at the newest matches" : `${name} must be a string`);
	const normalized = value.trim();
	if (blankOmitted && !normalized) return undefined;
	if (!normalized || normalized.length > max) fail(name === "cursor"
		? "cursor must be a returned nextCursor (1–128 characters); omit it to start at the newest matches" : `${name} must be 1–${max} characters`);
	return normalized;
}
function strings(value: unknown, name: string, maxItems = 32, maxLength = 128): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length < 1 || value.length > maxItems || value.some(item =>
		typeof item !== "string" || !item.trim() || item.length > maxLength)) {
		fail(`${name} must be a nonempty array of at most ${maxItems} nonblank strings (up to ${maxLength} characters each)`);
	}
	return [...new Set((value as string[]).map(item => item.trim()))].sort();
}
function validateSearch(body: Record<string, unknown>, namespace: boolean): SearchOptions {
	const allowed = namespace ? [...SEARCH_KEYS, "sessionIds", "machineIds", "cwd"] : SEARCH_KEYS;
	if (Object.keys(body).some(key => !allowed.includes(key))) fail("invalid search parameters");
	const query = optionalString(body.query, "query", 256);
	const from = optionalString(body.from, "from", 128, true);
	const to = optionalString(body.to, "to", 128, true);
	const cursor = optionalString(body.cursor, "cursor", 128, true);
	for (const [key, value] of [["from", from], ["to", to]] as const) {
		if (value !== undefined && timestamp(value) === null) fail(`${key} must be an ISO-8601 timestamp with timezone, e.g. 2026-09-30T00:00:00Z; omit it for no time bound`);
	}
	if (from !== undefined && to !== undefined && timestamp(from)! >= timestamp(to)!) fail("from must be before to");
	if (query === undefined && from === undefined && to === undefined) fail("query, from, or to is required");
	const limit = body.limit === undefined ? 20 : body.limit;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("limit must be between 1 and 50");
	const options: SearchOptions = { query, from, to, cursor, limit };
	for (const key of FILTERS) options[key] = strings(body[key], key);
	if (options.sources?.some(source => !["text", "toolCall", "toolResult", "custom"].includes(source))) fail("invalid sources");
	if (options.fields?.some(field => !["text", "toolResult", "custom", "toolCall.arguments"].includes(field) &&
		!/^toolCall\.arguments\.[^.\s]+(?:\.[^.\s]+)*$/.test(field))) fail("invalid fields");
	if (namespace) {
		options.sessionIds = strings(body.sessionIds, "sessionIds", 200);
		if (options.sessionIds?.some(id => !/^s_[A-Za-z0-9_-]+$/.test(id))) fail("sessionIds must contain session ids");
		options.machineIds = strings(body.machineIds, "machineIds", 200);
		if (body.cwd !== undefined) {
			if (typeof body.cwd !== "string" || !body.cwd.trim() || body.cwd.length > 4096) fail("cwd must be a nonblank session working directory");
			options.cwd = body.cwd;
		}
	}
	return options;
}
function searchParams(req: Request): SearchOptions {
	const params = new URL(req.url).searchParams;
	const body: Record<string, unknown> = {};
	for (const key of params.keys()) {
		if (!SEARCH_KEYS.includes(key) || params.getAll(key).length !== 1) fail("invalid search parameters");
		const value = params.get(key)!;
		if ((FILTERS as readonly string[]).includes(key)) {
			try { body[key] = JSON.parse(value); } catch { fail(`${key} must be a JSON string array`); }
		} else if (key === "limit") {
			if (!/^[1-9]\d*$/.test(value)) fail("limit must be between 1 and 50");
			body.limit = Number(value);
		} else body[key] = value;
	}
	return validateSearch(body, false);
}
function binding(options: SearchOptions): string {
	const { cursor: _cursor, ...conditions } = options;
	// Fold ASCII only: Unicode expansion must not bind two different literal searches.
	return JSON.stringify({ ...conditions, query: options.query?.replace(/[A-Z]/g, character => character.toLowerCase()),
		from: options.from === undefined ? undefined : new Date(options.from).toISOString(),
		to: options.to === undefined ? undefined : new Date(options.to).toISOString() });
}
function storeFor(fleet: FleetState): CursorStore {
	let store = cursorStores.get(fleet);
	if (!store) { store = { entries: new Map(), participants: 0 }; cursorStores.set(fleet, store); }
	for (const [token, state] of store.entries) {
		if (state.expiresAt <= Date.now()) { store.entries.delete(token); store.participants -= state.participants.length; }
	}
	return store;
}
function saveCursor(fleet: FleetState, state: CursorState): string {
	const store = storeFor(fleet);
	if (state.participants.length > MAX_CURSOR_PARTICIPANTS) fail("namespace is too large for a bounded search cursor", 503);
	while (store.entries.size >= MAX_CURSORS || store.participants + state.participants.length > MAX_CURSOR_PARTICIPANTS) {
		const oldest = store.entries.entries().next().value!;
		store.entries.delete(oldest[0]);
		store.participants -= oldest[1].participants.length;
	}
	const token = randomId("fs_");
	store.entries.set(token, state);
	store.participants += state.participants.length;
	return token;
}
function ownerAllowed(ctx: ApiContext, owner: SessionRecord, namespaceId: string, version: number): boolean {
	const scope = ctx.fleet.membership(owner.id);
	return ctx.sessions.get(owner.id) === owner && owner.superagent === true && owner.status === "live" &&
		ctx.agents.isOnline(owner.machineId) && scope.namespaceId === namespaceId && scope.membershipVersion === version;
}
function participantAllowed(ctx: ApiContext, participant: Participant, namespaceId: string): boolean {
	const record = ctx.sessions.get(participant.id);
	const scope = ctx.fleet.membership(participant.id);
	return record !== undefined && record.machineId === participant.machineId && scope.namespaceId === namespaceId && scope.membershipVersion === participant.version;
}
function assertScope(ctx: ApiContext, owner: SessionRecord, namespaceId: string, ownerVersion: number, participants: Participant[]): void {
	if (!ownerAllowed(ctx, owner, namespaceId, ownerVersion) || participants.some(participant => !participantAllowed(ctx, participant, namespaceId))) {
		fail("fleet search membership changed", 409);
	}
}
function unavailable(ctx: ApiContext, record: SessionRecord, extended: boolean): FailureReason | undefined {
	if (!ctx.agents.isOnline(record.machineId)) return "offline";
	if (!(extended ? supportsFleetSearchContext : supportsFleetMessageSearch)(ctx.agents.agentVersion(record.machineId))) return "unsupported";
	if (record.status !== "live" && (!isTerminalStatus(record.status) || !record.sessionFile)) return "history_unavailable";
	return undefined;
}
function compare(left: Boundary, right: Boundary): number {
	const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
	if (time) return time;
	if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
	return left.sequence - right.sequence;
}
function perSessionBefore(boundary: Boundary, id: string): { timestamp: string; sequence: number } {
	return { timestamp: boundary.timestamp, sequence: id === boundary.sessionId ? boundary.sequence : id > boundary.sessionId ? -1 : Number.MAX_SAFE_INTEGER };
}
function page(data: unknown, sessionId: string): SearchPage;
function page(data: unknown, sessionId: string, requireSequence: boolean): LegacySearchPage;
function page(data: unknown, sessionId: string, requireSequence = true): LegacySearchPage {
	if (!data || typeof data !== "object" || Array.isArray(data)) fail("worker returned invalid search data", 502);
	const value = data as Record<string, unknown>;
	if (!Array.isArray(value.hits) || typeof value.hasMore !== "boolean" ||
		!(value.leafId === null || typeof value.leafId === "string" && value.leafId.length > 0 && value.leafId.length <= 128) ||
		!(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length <= 128)) fail("worker returned invalid search data", 502);
	const hits = value.hits.map((raw: unknown): PublicHit => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("worker returned invalid search hit", 502);
		const hit = raw as Record<string, unknown>;
		if (typeof hit.id !== "string" || typeof hit.timestamp !== "string" || !Number.isFinite(Date.parse(hit.timestamp)) ||
			((requireSequence || hit.sequence !== undefined) && (typeof hit.sequence !== "number" || !Number.isSafeInteger(hit.sequence) || hit.sequence < 0)) ||
			typeof hit.role !== "string" || typeof hit.source !== "string" || typeof hit.snippet !== "string") fail("worker returned invalid search hit", 502);
		return { id: hit.id, timestamp: hit.timestamp, ...(hit.sequence === undefined ? {} : { sequence: hit.sequence as number }),
			sessionId, role: hit.role, source: hit.source, snippet: hit.snippet,
			...(typeof hit.toolName === "string" ? { toolName: hit.toolName } : {}),
			...(typeof hit.toolCallId === "string" ? { toolCallId: hit.toolCallId } : {}),
			...(hit.match === undefined ? {} : { match: hit.match }) };
	});
	return { hits, hasMore: value.hasMore, nextCursor: value.nextCursor as string | null, leafId: value.leafId as string | null };
}
/** Boundary validation owns argument errors; daemon branch/snapshot conflicts remain explicit. */
function workerErrorStatus(error: string): number {
	if (/active branch|snapshot|anchor|content.?cursor|toolCallId.*anchor|unknown session|history.*unavailable/i.test(error)) return 409;
	if (error === "cmd timeout") return 504;
	return 502;
}
function command(record: SessionRecord, name: "search" | "context", fields: Omit<CmdRequest, "reqId" | "cmd" | "id" | "path">): CmdRequest {
	const live = record.status === "live";
	return { reqId: newCmdReqId(), cmd: name === "search" ? live ? "fleet-search-messages" : "search-session-messages" :
		live ? "fleet-get-message" : "read-session-message", ...(live ? { id: record.id } : { path: record.sessionFile }), ...fields };
}

/** Namespace search pages are newest-first; cursors retain only frozen participants and cutoff, never transcripts. */
export async function searchFleetNamespace(req: Request, ctx: ApiContext, owner: SessionRecord, namespaceId: string, ownerVersion: number): Promise<Response> {
	try {
		let raw: unknown;
		try { raw = await req.json(); } catch { fail("invalid json body"); }
		const options = validateSearch(object(raw), true);
		assertScope(ctx, owner, namespaceId, ownerVersion, []);
		if (!supportsFleetSearchContext(ctx.agents.agentVersion(owner.machineId))) fail("namespace search requires agent 0.15.0+ on operator machine", 409);
		const queryBinding = binding(options);
		let previous: CursorState | undefined;
		let participants: Participant[];
		if (options.cursor !== undefined) {
			previous = storeFor(ctx.fleet).entries.get(options.cursor);
			if (!previous || previous.ownerId !== owner.id || previous.ownerVersion !== ownerVersion || previous.namespaceId !== namespaceId || previous.binding !== queryBinding) {
				fail("search cursor is unknown, expired, or does not belong to this owner and query", 409);
			}
			participants = previous.participants.map(participant => ({ ...participant }));
		} else {
			if (options.sessionIds?.some(id => !ctx.sessions.get(id) || ctx.fleet.membership(id).namespaceId !== namespaceId)) fail("session not found", 404);
			const allowedMachines = ctx.fleet.getNamespace(namespaceId)?.machineIds;
			if (options.machineIds?.some(id => !ctx.agents.getMachine(id) || (allowedMachines !== null && !allowedMachines?.includes(id)))) fail("machine not found", 404);
			participants = ctx.sessions.list().filter(record => ctx.fleet.membership(record.id).namespaceId === namespaceId &&
				(!options.sessionIds || options.sessionIds.includes(record.id)) && (!options.machineIds || options.machineIds.includes(record.machineId)) &&
				(options.cwd === undefined || record.cwd === options.cwd)).map(record => ({ id: record.id, machineId: record.machineId,
				version: ctx.fleet.membership(record.id).membershipVersion, failure: unavailable(ctx, record, true) }));
		}
		assertScope(ctx, owner, namespaceId, ownerVersion, participants);
		const hits: Hit[] = [];
		let hasMore = false;
		let index = 0;
		let searchedSessions = 0;
		const deadline = performance.now() + Math.min(SEARCH_TIMEOUT_MS, ctx.cfg.cmdTimeoutMs);
		await Promise.all(Array.from({ length: Math.min(FANOUT, participants.length) }, async () => {
			for (;;) {
				const participant = participants[index++];
				if (!participant) return;
				if (participant.failure) continue;
				assertScope(ctx, owner, namespaceId, ownerVersion, [participant]);
				const record = ctx.sessions.get(participant.id)!;
				participant.failure = unavailable(ctx, record, true);
				if (participant.failure) continue;
				const remaining = Math.ceil(deadline - performance.now());
				if (remaining <= 0) { participant.failure = "timeout"; continue; }
				const result = await ctx.agents.sendCmd(record.machineId, command(record, "search", {
					query: options.query, from: options.from, to: options.to, pageLimit: options.limit,
					roles: options.roles, toolNames: options.toolNames, sources: options.sources, fields: options.fields,
					searchOrder: "timestamp", ...(previous ? { snapshotLeafId: participant.leafId, searchBefore: perSessionBefore(previous.before, participant.id) } : {}) }), remaining);
				assertScope(ctx, owner, namespaceId, ownerVersion, [participant]);
				if (!result.ok) {
					if (/active branch|snapshot/i.test(result.error)) fail("search snapshot is no longer on the active branch", 409);
					participant.failure = !ctx.agents.isOnline(record.machineId) ? "offline" : result.error === "cmd timeout" ? "timeout" :
						/unknown session|history.*unavailable/i.test(result.error) ? "history_unavailable" : "worker_error";
					continue;
				}
				try {
					const response = page(result.data, participant.id);
					if (response.hits.length > options.limit || (response.hits.length > 0 && response.leafId === null) ||
						(response.hasMore && response.hits.length === 0) || (previous && response.leafId !== participant.leafId) ||
						(previous && response.hits.some(hit => compare(hit, previous!.before) >= 0))) {
						participant.failure = "worker_error";
						continue;
					}
					participant.leafId = response.leafId;
					hasMore ||= response.hasMore;
					// Keep only the global top-k; never retain every participant's transcript hits.
					for (const hit of response.hits) {
						if (hits.length === options.limit && compare(hit, hits[hits.length - 1]!) <= 0) { hasMore = true; continue; }
						let low = 0;
						let high = hits.length;
						while (low < high) {
							const middle = (low + high) >>> 1;
							if (compare(hits[middle]!, hit) > 0) low = middle + 1;
							else high = middle;
						}
						hits.splice(low, 0, hit);
						if (hits.length > options.limit) { hits.pop(); hasMore = true; }
					}
					searchedSessions++;
				} catch (error) {
					if (!(error instanceof PublicError) || error.status !== 502) throw error;
					participant.failure = "worker_error";
				}
			}
		}));
		assertScope(ctx, owner, namespaceId, ownerVersion, participants);
		if (previous && previous.expiresAt <= Date.now()) fail("search cursor expired", 409);
		const last = hits.at(-1);
		const nextCursor = hasMore && last ? saveCursor(ctx.fleet, { ownerId: owner.id, ownerVersion, namespaceId, binding: queryBinding, participants,
			before: { timestamp: last.timestamp, sessionId: last.sessionId, sequence: last.sequence }, expiresAt: previous?.expiresAt ?? Date.now() + CURSOR_TTL_MS }) : null;
		const failures = participants.filter(participant => participant.failure).map(participant => ({ sessionId: participant.id, machineId: participant.machineId, reason: participant.failure! }));
		return json({ hits, nextCursor, hasMore, partial: failures.length > 0, coverage: { totalSessions: participants.length, searchedSessions, failures } });
	} catch (error) { return failureResponse(error); }
}

/** Legacy single-session cursors remain message ids; only content filters require 0.15.0. */
export async function searchFleetSession(req: Request, ctx: ApiContext, owner: SessionRecord, worker: SessionRecord, namespaceId: string, ownerVersion: number, workerVersion: number): Promise<Response> {
	try {
		const options = searchParams(req);
		const participants = [{ id: worker.id, machineId: worker.machineId, version: workerVersion }];
		assertScope(ctx, owner, namespaceId, ownerVersion, participants);
		const extended = FILTERS.some(key => options[key] !== undefined);
		const supports = extended ? supportsFleetSearchContext : supportsFleetMessageSearch;
		if (!supports(ctx.agents.agentVersion(owner.machineId))) fail(`fleet message search requires agent ${extended ? "0.15.0" : "0.14.0"}+ on operator and worker machines`, 409);
		const reason = unavailable(ctx, worker, extended);
		if (reason) fail(reason === "unsupported" ? `fleet message search requires agent ${extended ? "0.15.0" : "0.14.0"}+ on operator and worker machines` :
			reason === "offline" ? "agent offline" : "session history unavailable", reason === "offline" ? 502 : 409);
		const result = await ctx.agents.sendCmd(worker.machineId, command(worker, "search", {
			query: options.query, from: options.from, to: options.to, cursor: options.cursor, pageLimit: options.limit,
			roles: options.roles, toolNames: options.toolNames, sources: options.sources, fields: options.fields,
		}));
		assertScope(ctx, owner, namespaceId, ownerVersion, participants);
		if (!result.ok) return json({ error: result.error }, workerErrorStatus(result.error));
		return json(page(result.data, worker.id, supportsFleetSearchContext(ctx.agents.agentVersion(worker.machineId))));
	} catch (error) { return failureResponse(error); }
}

/** Any namespace participant may read inclusive context, without claiming control of the target. */
export async function getFleetMessageContext(req: Request, ctx: ApiContext, owner: SessionRecord, worker: SessionRecord, namespaceId: string, ownerVersion: number, workerVersion: number): Promise<Response> {
	try {
		let raw: unknown;
		try { raw = await req.json(); } catch { fail("invalid json body"); }
		const body = object(raw);
		if (Object.keys(body).some(key => !["messageId", "before", "after", "leafId", "toolCallId", "contentCursor"].includes(key))) fail("invalid message-context parameters");
		const messageId = optionalString(body.messageId, "messageId", 128);
		if (!messageId) fail("messageId is required");
		const before = body.before === undefined ? 1 : body.before;
		const after = body.after === undefined ? 2 : body.after;
		if (typeof before !== "number" || typeof after !== "number" || !Number.isInteger(before) || !Number.isInteger(after) || before < 0 || before > 10 || after < 0 || after > 10) fail("before and after must be integers between 0 and 10");
		const leafId = optionalString(body.leafId, "leafId", 128);
		const toolCallId = optionalString(body.toolCallId, "toolCallId", 128);
		const contentCursor = optionalString(body.contentCursor, "contentCursor", 2048);
		const participants = [{ id: worker.id, machineId: worker.machineId, version: workerVersion }];
		assertScope(ctx, owner, namespaceId, ownerVersion, participants);
		if (!supportsFleetSearchContext(ctx.agents.agentVersion(owner.machineId))) fail("message context requires agent 0.15.0+ on operator and worker machines", 409);
		const reason = unavailable(ctx, worker, true);
		if (reason) fail(reason === "unsupported" ? "message context requires agent 0.15.0+ on operator and worker machines" :
			reason === "offline" ? "agent offline" : "session history unavailable", reason === "offline" ? 502 : 409);
		const result = await ctx.agents.sendCmd(worker.machineId, command(worker, "context", { messageId, before, after, leafId, toolCallId, contentCursor }));
		assertScope(ctx, owner, namespaceId, ownerVersion, participants);
		if (!result.ok) return json({ error: result.error }, workerErrorStatus(result.error));
		return json(result.data);
	} catch (error) { return failureResponse(error); }
}
