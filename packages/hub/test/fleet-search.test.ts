import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { startHub, type Hub } from "../src/server";
import type { SessionRecord } from "../src/sessions";

interface Entry {
	id: string;
	timestamp: string;
	role: string;
	source: string;
	snippet: string;
	toolName?: string;
	toolCallId?: string;
	field?: string;
}
interface Hit extends Entry { sessionId: string; sequence: number; match?: { field: string; contentCursor: string } }
interface SearchReply {
	hits: Hit[];
	nextCursor: string | null;
	hasMore: boolean;
	partial: boolean;
	coverage: { totalSessions: number; searchedSessions: number; failures: Array<{ sessionId: string; machineId: string; reason: string }> };
}
type Frame = Record<string, unknown>;
type Result = { ok: true; data: unknown } | { ok: false; error: string };
interface Daemon {
	id: string;
	version: string;
	ws: WebSocket;
	histories: Map<string, Entry[]>;
	commands: Frame[];
	hold?: (frame: Frame) => Promise<void>;
	error?: string;
	silent?: boolean;
}
const STAMP = "2026-09-30T12:00:00Z";
let hub: Hub;
let namespaceId: string;
const daemons: Daemon[] = [];

beforeEach(() => {
	hub = startHub({ port: 0, hostname: "127.0.0.1", token: "fleet-search-test", stateFile: null, cmdTimeoutMs: 500 });
	namespaceId = hub.fleet.createNamespace("search", null).id;
});
afterEach(() => {
	for (const daemon of daemons.splice(0)) daemon.ws.close();
	hub.stop();
});

function request(path: string, owner: SessionRecord, body?: unknown): Promise<Response> {
	return fetch(`${hub.url}${path}`, { method: body === undefined ? "GET" : "POST",
		headers: { authorization: "Bearer fleet-search-test", "x-fleet-owner": owner.id, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function search(owner: SessionRecord, body: unknown): Promise<SearchReply> {
	const reply = await request("/api/fleet/search", owner, body);
	expect(reply.status).toBe(200);
	return await reply.json() as SearchReply;
}
async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition did not settle");
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}
async function daemon(id: string, version = "0.15.0"): Promise<Daemon> {
	const ws = new WebSocket(`${hub.url.replace(/^http/, "ws")}/agent`, { headers: { authorization: "Bearer fleet-search-test" } });
	const instance: Daemon = { id, version, ws, histories: new Map(), commands: [] };
	daemons.push(instance);
	const open = Promise.withResolvers<void>();
	ws.addEventListener("open", () => open.resolve(), { once: true });
	ws.addEventListener("error", () => open.reject(new Error("daemon socket failed")), { once: true });
	ws.addEventListener("message", event => {
		if (typeof event.data !== "string") return;
		const frame = JSON.parse(event.data) as Frame;
		if (frame.t !== "cmd") return;
		instance.commands.push(frame);
		if (instance.silent) return;
		void (async () => {
			await instance.hold?.(frame);
			const result = instance.error ? { ok: false as const, error: instance.error } : answer(instance, frame);
			ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
		})();
	});
	await open.promise;
	ws.send(JSON.stringify({ t: "hello", machineId: id, name: id, version }));
	await eventually(() => hub.agents.isOnline(id) && hub.agents.agentVersion(id) === version);
	return instance;
}
function session(machine: Daemon, opts: { operator?: boolean; cwd?: string; namespace?: string; terminal?: boolean; starting?: boolean } = {}): SessionRecord {
	const record = hub.sessions.create({ machineId: machine.id, machineName: machine.id, cwd: opts.cwd ?? "/project",
		...(opts.operator ? { superagent: true } : {}) });
	hub.sessions.applyMembership(record.id, hub.fleet.assign(record.id, opts.namespace ?? namespaceId)!);
	const path = `/managed/${record.id}.jsonl`;
	machine.histories.set(record.id, []);
	machine.histories.set(path, machine.histories.get(record.id)!);
	if (!opts.starting) hub.sessions.markReady(record.id, { sessionFile: path });
	if (opts.terminal) hub.sessions.markExited(record.id);
	return record;
}
function entry(id: string, snippet = "needle", extra: Partial<Entry> = {}): Entry {
	return { id, timestamp: STAMP, role: "assistant", source: "text", snippet, ...extra };
}
function replaceHistory(machine: Daemon, record: SessionRecord, entries: Entry[]): void {
	machine.histories.set(record.id, entries);
	machine.histories.set(`/managed/${record.id}.jsonl`, entries);
}
function answer(machine: Daemon, frame: Frame): Result {
	const live = typeof frame.id === "string";
	const record = live ? hub.sessions.get(frame.id as string) : hub.sessions.list().find(candidate => candidate.sessionFile === frame.path);
	if (!record || (live ? record.status !== "live" : record.status !== "exited")) return { ok: false, error: "invalid history target" };
	const entries = machine.histories.get((live ? frame.id : frame.path) as string);
	if (!entries) return { ok: false, error: "unreadable history" };
	if (frame.cmd === (live ? "fleet-get-message" : "read-session-message")) {
		const leaf = frame.leafId === undefined ? entries.length - 1 : entries.findIndex(row => row.id === frame.leafId);
		const anchor = entries.findIndex(row => row.id === frame.messageId);
		if (leaf < 0 || anchor < 0 || anchor > leaf) return { ok: false, error: "message anchor is not on the active branch" };
		const related = entries.slice(0, leaf + 1).filter(row => row.toolCallId && row.toolCallId === entries[anchor]!.toolCallId);
		const window = entries.slice(Math.max(0, anchor - Number(frame.before)), Math.min(leaf + 1, anchor + Number(frame.after) + 1));
		const selected = entries.slice(0, leaf + 1).filter(row => window.includes(row) || related.includes(row));
		return { ok: true, data: { anchorId: frame.messageId, leafId: entries[leaf]!.id,
			messages: selected.map(row => ({ id: row.id, timestamp: row.timestamp, role: row.role, content: row.snippet, contentCursor: `visible:${row.id}` })),
			relatedIds: related.filter(row => row.id !== frame.messageId).map(row => row.id),
			...(frame.contentCursor ? { content: { messageId: frame.messageId, blockIndex: 0, field: "text", value: entries[anchor]!.snippet, offset: 0, nextCursor: null } } : {}) } };
	}
	if (frame.cmd !== (live ? "fleet-search-messages" : "search-session-messages")) return { ok: false, error: "wrong search routing" };
	const frozen = frame.snapshotLeafId;
	const end = frozen === undefined ? entries.length : frozen === null ? 0 : entries.findIndex(row => row.id === frozen) + 1;
	if (frozen !== undefined && frozen !== null && end === 0) return { ok: false, error: "search snapshot is not on the active branch" };
	const before = frame.searchBefore as { timestamp: string; sequence: number } | undefined;
	let eligible = entries.slice(0, end).map((row, sequence) => ({ ...row, sequence })).filter(row =>
		(frame.query === undefined || row.snippet.toLowerCase().includes(String(frame.query).toLowerCase())) &&
		(frame.from === undefined || Date.parse(row.timestamp) >= Date.parse(String(frame.from))) &&
		(frame.to === undefined || Date.parse(row.timestamp) < Date.parse(String(frame.to))) &&
		(["roles", "toolNames", "sources", "fields"] as const).every(key => {
			const values = frame[key] as string[] | undefined;
			const candidate = key === "roles" ? row.role : key === "toolNames" ? row.toolName : key === "sources" ? row.source : row.field ?? "text";
			return !values || (candidate !== undefined && values.includes(candidate));
		}) && (!before || Date.parse(row.timestamp) < Date.parse(before.timestamp) ||
			(Date.parse(row.timestamp) === Date.parse(before.timestamp) && row.sequence < before.sequence)));
	if (frame.searchOrder === "timestamp") eligible.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp) || right.sequence - left.sequence);
	else {
		eligible.reverse();
		if (frame.cursor !== undefined) {
			const sequence = entries.findIndex(row => row.id === frame.cursor);
			if (sequence < 0) return { ok: false, error: "cursor is not on the active branch" };
			eligible = eligible.filter(row => row.sequence < sequence);
		}
	}
	const selected = eligible.slice(0, Number(frame.pageLimit));
	return { ok: true, data: { hits: selected.toReversed().map(row => machine.version === "0.14.0"
		? { id: row.id, timestamp: row.timestamp, role: row.role, source: row.source, snippet: row.snippet }
		: { ...row, match: { blockIndex: 0, field: row.field ?? "text", start: 0,
			end: row.snippet.length, contentCursor: `visible:${row.id}` } }), hasMore: eligible.length > selected.length,
		nextCursor: selected.at(-1)?.id ?? null, leafId: entries[end - 1]?.id ?? null } };
}

// These tests drive the actual HTTP listener and authenticated daemon WebSocket.
describe("namespace fleet search", () => {
	test("merges timestamp ties without gaps, includes terminal/operator history, and never searches another namespace", async () => {
		const machine = await daemon("main");
		const owner = session(machine, { operator: true });
		const first = session(machine);
		const second = session(machine, { terminal: true });
		const hidden = session(machine, { namespace: hub.fleet.createNamespace("hidden", null).id });
		replaceHistory(machine, owner, [entry("owner", "needle owner", { timestamp: "2026-09-30T13:00:00Z" })]);
		replaceHistory(machine, first, [entry("first-0"), entry("first-1"), entry("first-2", "needle old", { timestamp: "2026-09-30T10:00:00Z" })]);
		replaceHistory(machine, second, [entry("second-0"), entry("second-1")]);
		replaceHistory(machine, hidden, [entry("secret", "needle private", { timestamp: "2026-09-30T14:00:00Z" })]);
		const expected = [owner, first, second].flatMap(record => machine.histories.get(record.id)!.map((row, sequence) => ({ ...row, sessionId: record.id, sequence })))
			.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp) || (left.sessionId === right.sessionId ? right.sequence - left.sequence : left.sessionId < right.sessionId ? 1 : -1));
		const found: Hit[] = [];
		let cursor: string | undefined;
		for (;;) {
			const result = await search(owner, { query: "needle", limit: 2, ...(cursor ? { cursor } : {}) });
			expect(result.partial).toBe(false);
			expect(result.coverage).toEqual({ totalSessions: 3, searchedSessions: 3, failures: [] });
			found.push(...result.hits);
			if (!result.hasMore) { expect(result.nextCursor).toBeNull(); break; }
			expect(result.nextCursor).not.toBeNull();
			cursor = result.nextCursor!;
		}
		expect(found.map(row => [row.sessionId, row.id, row.sequence])).toEqual(expected.map(row => [row.sessionId, row.id, row.sequence]));
		expect(machine.commands.some(frame => frame.id === hidden.id || frame.path === hidden.sessionFile)).toBe(false);
		expect((await request("/api/fleet/search", owner, { query: "needle", sessionIds: [hidden.id] })).status).toBe(404);
	});

	test("filters exact session cwd and same eligible hit metadata across native and GET filter arrays", async () => {
		const machine = await daemon("filters");
		const owner = session(machine, { operator: true });
		const worker = session(machine, { cwd: "/exact" });
		const other = session(machine, { cwd: "/exact/sub" });
		replaceHistory(machine, worker, [entry("plain"), entry("result", "needle stdout", { role: "toolResult", source: "toolResult", toolName: "bash", field: "toolResult" }),
			entry("command", "needle --cwd /elsewhere", { source: "toolCall", toolName: "bash", field: "toolCall.arguments.command", toolCallId: "call-1" }),
			entry("wrong-tool", "needle", { source: "toolCall", toolName: "read", field: "toolCall.arguments.command" })]);
		replaceHistory(machine, other, [entry("wrong-cwd", "needle", { source: "toolCall", toolName: "bash", field: "toolCall.arguments.command" })]);
		const filters = { roles: ["assistant"], toolNames: ["bash"], sources: ["toolCall"], fields: ["toolCall.arguments.command"] };
		const result = await search(owner, { query: "needle", cwd: "/exact", ...filters });
		expect(result.hits.map(row => [row.id, row.sessionId, row.toolName, row.match?.field])).toEqual([["command", worker.id, "bash", "toolCall.arguments.command"]]);
		expect(result.coverage.totalSessions).toBe(1);
		const params = new URLSearchParams({ query: "needle", ...Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, JSON.stringify(value)])) });
		const single = await request(`/api/fleet/sessions/${worker.id}/search?${params}`, owner);
		expect(single.status).toBe(200);
		expect(((await single.json()) as SearchReply).hits.map(row => [row.id, row.sessionId, row.match?.contentCursor])).toEqual([["command", worker.id, "visible:command"]]);
		const machineScope = await search(owner, { query: "needle", machineIds: [machine.id], sessionIds: [worker.id], sources: ["toolResult"] });
		expect(machineScope.hits.map(row => row.id)).toEqual(["result"]);
	});

	test("declares offline, unsupported, no-history, timeout and worker failures instead of empty success", async () => {
		const good = await daemon("good");
		const owner = session(good, { operator: true });
		replaceHistory(good, owner, [entry("accessible")]);
		const old = session(await daemon("old", "0.14.0"));
		const offlineDaemon = await daemon("offline");
		const offline = session(offlineDaemon);
		offlineDaemon.ws.close();
		await eventually(() => !hub.agents.isOnline(offlineDaemon.id));
		const starting = session(good, { starting: true });
		const silentDaemon = await daemon("silent");
		const silent = session(silentDaemon);
		silentDaemon.silent = true;
		const brokenDaemon = await daemon("broken");
		const broken = session(brokenDaemon);
		brokenDaemon.error = "read denied /private/managed/transcript.jsonl";
		const result = await search(owner, { query: "needle" });
		expect(result.hits.map(row => row.id)).toEqual(["accessible"]);
		expect(result.partial).toBe(true);
		expect(result.coverage.totalSessions).toBe(6);
		expect(result.coverage.searchedSessions).toBe(1);
		expect(Object.fromEntries(result.coverage.failures.map(row => [row.sessionId, row.reason]))).toEqual({
			[old.id]: "unsupported", [offline.id]: "offline", [starting.id]: "history_unavailable", [silent.id]: "timeout", [broken.id]: "worker_error" });
		expect(JSON.stringify(result)).not.toContain("/private/");
	});

	test("queued slow sessions return declared failures within one search budget", async () => {
		const fast = await daemon("budget-fast");
		const slow = await daemon("budget-slow");
		const workers = Array.from({ length: 9 }, () => session(slow));
		slow.silent = true;
		const owner = session(fast, { operator: true });
		replaceHistory(fast, owner, [entry("available")]);
		const response = await fetch(`${hub.url}/api/fleet/search`, {
			method: "POST",
			headers: { authorization: "Bearer fleet-search-test", "x-fleet-owner": owner.id, "content-type": "application/json" },
			body: JSON.stringify({ query: "needle" }),
			signal: AbortSignal.timeout(900),
		});
		expect(response.status).toBe(200);
		const result = await response.json() as SearchReply;
		expect(result.hits.map(hit => hit.id)).toEqual(["available"]);
		expect(result.partial).toBe(true);
		expect(result.coverage.totalSessions).toBe(10);
		expect(result.coverage.searchedSessions).toBe(1);
		expect(result.coverage.failures.map(failure => [failure.sessionId, failure.reason]).sort())
			.toEqual(workers.map(worker => [worker.id, "timeout"]).sort());
	});

	test("frozen leaves exclude appends and new sessions while retaining unused same-timestamp candidates", async () => {
		const machine = await daemon("frozen");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [entry("one"), entry("two"), entry("three")]);
		const first = await search(owner, { query: "needle", limit: 1 });
		expect(first.hits.map(row => row.id)).toEqual(["three"]);
		machine.histories.get(worker.id)!.push(entry("appended", "needle", { timestamp: "2026-09-30T15:00:00Z" }));
		machine.histories.get(owner.id)!.push(entry("owner-appended", "needle", { timestamp: "2026-09-30T16:00:00Z" }));
		const newcomer = session(machine);
		replaceHistory(machine, newcomer, [entry("new-session", "needle", { timestamp: "2026-09-30T17:00:00Z" })]);
		const second = await search(owner, { query: "needle", limit: 1, cursor: first.nextCursor });
		const third = await search(owner, { query: "needle", limit: 1, cursor: second.nextCursor });
		expect([...second.hits, ...third.hits].map(row => row.id)).toEqual(["two", "one"]);
		expect(third.hasMore).toBe(false);
		expect(second.coverage.totalSessions).toBe(2);
	});

	test("failed participants stay declared rather than joining an existing snapshot after upgrading", async () => {
		const machine = await daemon("snapshot-main");
		const owner = session(machine, { operator: true });
		replaceHistory(machine, owner, [entry("one"), entry("two")]);
		const oldDaemon = await daemon("snapshot-old", "0.14.0");
		const old = session(oldDaemon);
		replaceHistory(oldDaemon, old, [entry("late-hit")]);
		const first = await search(owner, { query: "needle", limit: 1 });
		oldDaemon.ws.close();
		await eventually(() => !hub.agents.isOnline(oldDaemon.id));
		const upgraded = await daemon(oldDaemon.id);
		replaceHistory(upgraded, old, [entry("late-hit")]);
		const second = await search(owner, { query: "needle", limit: 1, cursor: first.nextCursor });
		expect(second.hits.map(row => row.id)).toEqual(["one"]);
		expect(second.coverage.failures).toEqual([{ sessionId: old.id, machineId: oldDaemon.id, reason: "unsupported" }]);
	});

	test("time-only searches use inclusive from and exclusive to bounds", async () => {
		const machine = await daemon("time-bounds");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [
			entry("too-early", "anything", { timestamp: "2026-09-30T10:59:59Z" }),
			entry("inclusive", "anything", { timestamp: "2026-09-30T11:00:00Z" }),
			entry("inside", "anything", { timestamp: "2026-09-30T11:30:00Z" }),
			entry("exclusive", "anything", { timestamp: "2026-09-30T12:00:00Z" }),
		]);
		const result = await search(owner, { from: "2026-09-30T11:00:00Z", to: "2026-09-30T12:00:00Z" });
		expect(result.hits.map(hit => hit.id)).toEqual(["inside", "inclusive"]);
		expect(result.coverage.failures).toEqual([]);
	});

	test("searches every selected participant with bounded concurrency, not a silent scan cap", async () => {
		const machine = await daemon("fanout");
		const owner = session(machine, { operator: true });
		const workers = Array.from({ length: 12 }, (_, index) => {
			const worker = session(machine);
			replaceHistory(machine, worker, [entry(`worker-${index}`)]);
			return worker;
		});
		const release = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		machine.hold = async () => {
			active++;
			peak = Math.max(peak, active);
			await release.promise;
			active--;
		};
		const response = request("/api/fleet/search", owner, { query: "needle", limit: 50 });
		await eventually(() => machine.commands.length === 8);
		expect(active).toBe(8);
		release.resolve();
		const reply = await response;
		expect(reply.status).toBe(200);
		const result = await reply.json() as SearchReply;
		expect(peak).toBeLessThanOrEqual(8);
		expect(result.hits.map(hit => hit.sessionId).sort()).toEqual(workers.map(worker => worker.id).sort());
		expect(result.coverage).toEqual({ totalSessions: 13, searchedSessions: 13, failures: [] });
	});

	test("binds opaque cursors to normalized query, owner, namespace and filters, and expires them", async () => {
		const machine = await daemon("cursor");
		const owner = session(machine, { operator: true });
		const otherOwner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [entry("one"), entry("two")]);
		const first = await search(owner, { query: "Needle", limit: 1 });
		expect(first.nextCursor).not.toBe("two");
		for (const body of [{ query: "other", limit: 1, cursor: first.nextCursor }, { query: "needle", limit: 1, cursor: "unknown" },
			{ query: "needle", limit: 1, roles: ["assistant"], cursor: first.nextCursor }]) {
			expect((await request("/api/fleet/search", owner, body)).status).toBe(409);
		}
		expect((await request("/api/fleet/search", otherOwner, { query: "needle", limit: 1, cursor: first.nextCursor })).status).toBe(409);
		const same = await search(owner, { query: " needle ", limit: 1, cursor: first.nextCursor });
		expect(same.hits.map(row => row.id)).toEqual(["one"]);
		const future = Date.now() + 5 * 60_000 + 1;
		const clock = spyOn(Date, "now").mockReturnValue(future);
		try {
			expect((await request("/api/fleet/search", owner, { query: "needle", limit: 1, cursor: first.nextCursor })).status).toBe(409);
		} finally { clock.mockRestore(); }
	});

	test("Unicode case expansion cannot reuse a cursor for a different literal query", async () => {
		const machine = await daemon("unicode-cursor");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [entry("one", "İ"), entry("two", "İ")]);
		const first = await search(owner, { query: "İ", limit: 1 });
		expect(first.hits.map(hit => hit.id)).toEqual(["two"]);
		const changed = await request("/api/fleet/search", owner, { query: "i\u0307", limit: 1, cursor: first.nextCursor });
		expect(changed.status).toBe(409);
	});

	test("rewound leaves and membership moves invalidate cursors rather than resetting search", async () => {
		const machine = await daemon("rewind");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [entry("one"), entry("two")]);
		const first = await search(owner, { query: "needle", limit: 1 });
		replaceHistory(machine, worker, [entry("one")]);
		expect((await request("/api/fleet/search", owner, { query: "needle", limit: 1, cursor: first.nextCursor })).status).toBe(409);
		replaceHistory(machine, worker, [entry("one"), entry("two")]);
		const moved = await search(owner, { query: "needle", limit: 1 });
		const elsewhere = hub.fleet.createNamespace("elsewhere", null).id;
		hub.sessions.applyMembership(worker.id, hub.fleet.assign(worker.id, elsewhere)!);
		hub.sessions.applyMembership(worker.id, hub.fleet.assign(worker.id, namespaceId)!);
		expect((await request("/api/fleet/search", owner, { query: "needle", limit: 1, cursor: moved.nextCursor })).status).toBe(409);
		const ownerCursor = await search(owner, { query: "needle", limit: 1 });
		hub.sessions.applyMembership(owner.id, hub.fleet.assign(owner.id, elsewhere)!);
		expect((await request("/api/fleet/search", owner, { query: "needle", limit: 1, cursor: ownerCursor.nextCursor })).status).toBe(409);
	});

	test("an empty candidate set has explicit complete coverage", async () => {
		const machine = await daemon("empty");
		const owner = session(machine, { operator: true });
		const result = await search(owner, { query: "needle", cwd: "/absent" });
		expect(result).toEqual({ hits: [], nextCursor: null, hasMore: false, partial: false, coverage: { totalSessions: 0, searchedSessions: 0, failures: [] } });
	});
});

describe("single-session filters and inclusive context", () => {
	test("0.14 legacy searches retain blank optional normalization but extended APIs require 0.15", async () => {
		const machine = await daemon("legacy", "0.14.0");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [entry("legacy-hit")]);
		const old = await request(`/api/fleet/sessions/${worker.id}/search?query=needle&from=%20&to=&cursor=%20`, owner);
		expect(old.status).toBe(200);
		expect(((await old.json()) as SearchReply).hits.map(row => [row.id, row.sessionId])).toEqual([["legacy-hit", worker.id]]);
		expect((await request(`/api/fleet/sessions/${worker.id}/search?query=needle&roles=%5B%22assistant%22%5D`, owner)).status).toBe(409);
		expect((await request("/api/fleet/search", owner, { query: "needle" })).status).toBe(409);
		expect((await request(`/api/fleet/sessions/${worker.id}/message-context`, owner, { messageId: "legacy-hit" })).status).toBe(409);
	});

	test("context permits unclaimed readers, includes the anchor with zero neighbors, and pairs nonadjacent tools", async () => {
		const machine = await daemon("context");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		replaceHistory(machine, worker, [entry("before"), entry("call", "needle call", { source: "toolCall", toolCallId: "c1" }),
			entry("between"), entry("result", "needle result", { role: "toolResult", source: "toolResult", toolCallId: "c1" }), entry("after")]);
		const response = await request(`/api/fleet/sessions/${worker.id}/message-context`, owner, { messageId: "call", before: 0, after: 0 });
		expect(response.status).toBe(200);
		const context = await response.json() as { anchorId: string; leafId: string; messages: Array<{ id: string; contentCursor: string }>; relatedIds: string[] };
		expect(context.anchorId).toBe("call");
		expect(context.leafId).toBe("after");
		expect(context.messages.map(row => row.id)).toEqual(["call", "result"]);
		expect(context.relatedIds).toEqual(["result"]);
		const content = await request(`/api/fleet/sessions/${worker.id}/message-context`, owner, { messageId: "call", leafId: context.leafId,
			before: 0, after: 0, toolCallId: "c1", contentCursor: context.messages[0]!.contentCursor });
		expect(content.status).toBe(200);
		expect((await content.json() as { content: { value: string } }).content.value).toBe("needle call");
		const hidden = session(machine, { namespace: hub.fleet.createNamespace("hidden-context", null).id });
		replaceHistory(machine, hidden, [entry("private-anchor")]);
		expect((await request(`/api/fleet/sessions/${hidden.id}/message-context`, owner, { messageId: "private-anchor" })).status).toBe(404);
		expect(machine.commands.some(frame => frame.id === hidden.id)).toBe(false);
	});

	test("terminal context uses readable stored history and propagates hidden or rewound anchor conflicts", async () => {
		const machine = await daemon("terminal-context");
		const owner = session(machine, { operator: true });
		const worker = session(machine, { terminal: true });
		replaceHistory(machine, worker, [entry("old"), entry("anchor"), entry("leaf")]);
		const response = await request(`/api/fleet/sessions/${worker.id}/message-context`, owner, { messageId: "anchor", before: 1, after: 1 });
		expect(response.status).toBe(200);
		expect((await response.json() as { messages: Array<{ id: string }> }).messages.map(row => row.id)).toEqual(["old", "anchor", "leaf"]);
		for (const body of [{ messageId: "missing" }, { messageId: "anchor", leafId: "old" }, { messageId: "anchor", leafId: "missing" }]) {
			expect((await request(`/api/fleet/sessions/${worker.id}/message-context`, owner, body)).status).toBe(409);
		}
	});

	test("validates boundary arguments before any daemon search or context dispatch", async () => {
		const machine = await daemon("validation");
		const owner = session(machine, { operator: true });
		const worker = session(machine);
		for (const body of [{}, { query: "" }, { query: "needle", limit: "1" }, { query: "needle", limit: 0 }, { query: "needle", limit: 1.5 },
			{ query: "needle", roles: [] }, { query: "needle", roles: [1] }, { query: "needle", sources: ["thinking"] }, { query: "needle", fields: ["toolCall"] },
			{ query: "needle", from: "2026-02-30T00:00:00Z" }, { query: "needle", from: STAMP, to: STAMP }, { query: "needle", cursor: null },
			{ query: "needle", snapshotLeafId: "injected" }, { query: "needle", sessionIds: ["/arbitrary/file"] }, { query: "needle", cwd: "" }]) {
			expect((await request("/api/fleet/search", owner, body)).status).toBe(400);
		}
		for (const params of ["query=needle&query=other", "query=needle&limit=01", "query=needle&roles=assistant", "query=needle&roles=[]", "query=needle&from=nonsense", "query=needle&cwd=/project"]) {
			expect((await request(`/api/fleet/sessions/${worker.id}/search?${params}`, owner)).status).toBe(400);
		}
		for (const body of [{}, { messageId: "" }, { messageId: "anchor", before: -1 }, { messageId: "anchor", after: 11 }, { messageId: "anchor", before: "1" },
			{ messageId: "anchor", after: 0.5 }, { messageId: "anchor", leafId: null }, { messageId: "anchor", contentCursor: "" }, { messageId: "anchor", path: "/private" }]) {
			expect((await request(`/api/fleet/sessions/${worker.id}/message-context`, owner, body)).status).toBe(400);
		}
		expect(machine.commands).toEqual([]);
	});
});

for (const route of ["namespace", "single", "context"] as const) {
	for (const moving of ["owner", "worker"] as const) {
		test(`${route} refuses stale content when ${moving} leaves its namespace during dispatch`, async () => {
			const machine = await daemon(`move-${route}-${moving}`);
			const owner = session(machine, { operator: true });
			const worker = session(machine);
			replaceHistory(machine, worker, [entry("secret-after-move")]);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			machine.hold = async frame => {
				if (frame.id !== worker.id) return;
				started.resolve();
				await release.promise;
			};
			const response = route === "namespace" ? request("/api/fleet/search", owner, { query: "needle", sessionIds: [worker.id] }) :
				route === "single" ? request(`/api/fleet/sessions/${worker.id}/search?query=needle`, owner) :
				request(`/api/fleet/sessions/${worker.id}/message-context`, owner, { messageId: "secret-after-move" });
			await started.promise;
			const record = moving === "owner" ? owner : worker;
			hub.sessions.applyMembership(record.id, hub.fleet.assign(record.id, hub.fleet.createNamespace("moved", null).id)!);
			release.resolve();
			const reply = await response;
			expect(reply.status).toBe(409);
			expect(await reply.text()).not.toContain("secret-after-move");
		});
	}
}
