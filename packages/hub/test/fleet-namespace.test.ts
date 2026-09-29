import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FleetEvent } from "../src/fleet-state";
import { startHub, type Hub } from "../src/server";

const LINKS = { full: "wss://relay.example/r/room#write", view: "wss://relay.example/r/room#view",
	web: "https://relay.example/#write", webView: "https://relay.example/#view" };
let hub: Hub;

function api(path: string, init: RequestInit = {}, ownerId?: string): Promise<Response> {
	return fetch(`${hub.url}${path}`, {
		...init,
		headers: { authorization: "Bearer fleet-test", "content-type": "application/json",
			...(ownerId ? { "x-fleet-owner": ownerId } : {}), ...init.headers },
	});
}

async function socket(machineId: string, version = "0.13.0"): Promise<{ ws: WebSocket; take(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> }> {
	const ws = new WebSocket(`${hub.url.replace(/^http/, "ws")}/agent`, { headers: { authorization: "Bearer fleet-test" } });
	const frames: Record<string, unknown>[] = [];
	ws.addEventListener("message", event => {
		if (typeof event.data === "string") frames.push(JSON.parse(event.data) as Record<string, unknown>);
	});
	const ready = Promise.withResolvers<void>();
	ws.addEventListener("open", () => ready.resolve(), { once: true });
	ws.addEventListener("error", () => ready.reject(new Error("socket failed")), { once: true });
	await ready.promise;
	ws.send(JSON.stringify({ t: "hello", machineId, name: machineId, version }));
	const take = async (predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
		const deadline = Date.now() + 3000;
		for (;;) {
			const index = frames.findIndex(predicate);
			if (index >= 0) return frames.splice(index, 1)[0]!;
			if (Date.now() >= deadline) throw new Error(`timed out awaiting frame on ${machineId}: ${JSON.stringify(frames)}`);
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	};
	await take(frame => frame.t === "welcome");
	return { ws, take };
}

async function createNamespace(name: string): Promise<string> {
	const reply = await api("/api/namespaces", { method: "POST", body: JSON.stringify({ name }) });
	expect(reply.status).toBe(201);
	return ((await reply.json()) as { namespace: { id: string } }).namespace.id;
}

async function live(machine: { ws: WebSocket; take(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> }, machineId: string, opts: Record<string, unknown>): Promise<string> {
	const reply = await api("/api/sessions", { method: "POST", body: JSON.stringify({ machineId, cwd: "/tmp", ...opts }) });
	expect(reply.status).toBe(202);
	const { session } = await reply.json() as { session: { id: string } };
	await machine.take(frame => frame.t === "start" && frame.id === session.id);
	machine.ws.send(JSON.stringify({ t: "session-ready", id: session.id, sessionFile: "/tmp/agent/sessions/test.jsonl", links: LINKS }));
	for (let i = 0; i < 100; i++) {
		const state = await api(`/api/sessions/${session.id}`);
		if (((await state.json()) as { session: { status: string } }).session.status === "live") return session.id;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	throw new Error("session did not become live");
}

beforeAll(() => { hub = startHub({ port: 0, hostname: "127.0.0.1", token: "fleet-test", stateFile: null }); });
afterAll(() => hub.stop());

describe("namespace-scoped fleet control", () => {
	test("admin assigns namespaces and fleet cannot enumerate or control outside its namespace", async () => {
		const agent = await socket("m_scope");
		try {
			const first = await createNamespace("scope-one");
			const second = await createNamespace("scope-two");
			const owner = await live(agent, "m_scope", { superagent: true, namespaceId: first });
			const worker = await live(agent, "m_scope", { namespaceId: first });
			const other = await live(agent, "m_scope", { namespaceId: second });
			const scoped = await api("/api/fleet/sessions", {}, owner);
			const listing = (await scoped.json()) as { sessions: Array<{ id: string; links?: unknown }> };
			expect(listing.sessions.map(record => record.id).sort()).toEqual([owner, worker].sort());
			expect(listing.sessions.every(record => record.links === undefined)).toBe(true);
			expect(await (await api("/api/machines")).json()).toMatchObject({
				machines: [{ machineId: "m_scope", sessionCount: 3 }],
			});
			expect(await (await api("/api/fleet/machines", {}, owner)).json()).toMatchObject({
				machines: [{ machineId: "m_scope", sessionCount: 2 }],
			});
			expect((await api(`/api/fleet/sessions/${other}`, {}, owner)).status).toBe(404);
			expect((await api(`/api/fleet/sessions/${other}/messages`, {}, owner)).status).toBe(404);
			expect((await api(`/api/fleet/sessions/${other}/stop`, { method: "POST" }, owner)).status).toBe(404);
			expect((await api(`/api/fleet/sessions/${worker}/stop`, { method: "POST" }, owner)).status).toBe(403);
			const claim = await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, owner);
			expect(claim.status).toBe(200);
			const stopping = await api(`/api/fleet/sessions/${worker}/stop`, { method: "POST" }, owner);
			expect(stopping.status).toBe(200);
			await agent.take(frame => frame.t === "stop" && frame.id === worker);
		} finally { agent.ws.close(); }
	});

	test("forks a controlled live worker into an independent, scoped session", async () => {
		const agent = await socket("m_fork");
		try {
			const namespaceId = await createNamespace("fork-workers");
			const owner = await live(agent, "m_fork", { superagent: true, namespaceId });
			const worker = await live(agent, "m_fork", { namespaceId, profile: "team" });
			const other = await live(agent, "m_fork", { namespaceId });
			const input = { machineId: "m_fork", cwd: "/tmp", forkFrom: worker, prompt: "Try another approach" };
			const start = () => api("/api/fleet/sessions", { method: "POST", body: JSON.stringify(input) }, owner);

			expect((await start()).status).toBe(403);
			expect((await api("/api/fleet/sessions", { method: "POST", body: JSON.stringify({
				...input, forkFrom: owner,
			}) }, owner)).status).toBe(403);
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, owner)).status).toBe(200);
			expect((await api("/api/fleet/sessions", { method: "POST", body: JSON.stringify({
				...input, cwd: "/elsewhere",
			}) }, owner)).status).toBe(400);
			expect((await api("/api/fleet/sessions", { method: "POST", body: JSON.stringify({
				...input, profile: "default",
			}) }, owner)).status).toBe(400);

			const busy = start();
			const busyCmd = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-fork-session" && frame.id === worker);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: busyCmd.reqId, ok: false,
				error: "session is busy; wait for the current turn" }));
			expect((await busy).status).toBe(409);

			const pending = start();
			const forkCmd = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-fork-session" && frame.id === worker);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: forkCmd.reqId, ok: true,
				data: { sessionFile: "/tmp/agent/sessions/forked.jsonl" } }));
			const response = await pending;
			expect(response.status).toBe(202);
			const payload = await response.json() as { session: { id: string; controllerId: string; namespaceId: string; sessionFile?: string } };
			expect(payload.session).toMatchObject({ controllerId: owner, namespaceId });
			expect(payload.session.sessionFile).toBeUndefined();
			expect(payload.session.id).not.toBe(worker);
			expect(payload.session.id).not.toBe(other);
			const frame = await agent.take(value => value.t === "start" && value.id === payload.session.id);
			expect(frame).toMatchObject({ sessionFile: "/tmp/agent/sessions/forked.jsonl",
				prompt: "Try another approach", cwd: "/tmp", profile: "team" });
			expect(frame.superagent).toBeUndefined();
			expect(await (await api(`/api/sessions/${worker}`)).json()).toMatchObject({
				session: { status: "live", sessionFile: "/tmp/agent/sessions/test.jsonl" },
			});
		} finally { agent.ws.close(); }
	});

	test("a concurrent namespace move waits until fork dispatch finishes", async () => {
		const agent = await socket("m_fork_move");
		try {
			const original = await createNamespace("fork-move-original");
			const destination = await createNamespace("fork-move-destination");
			const owner = await live(agent, "m_fork_move", { superagent: true, namespaceId: original });
			const worker = await live(agent, "m_fork_move", { namespaceId: original });
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, owner)).status).toBe(200);
			const starting = api("/api/fleet/sessions", { method: "POST", body: JSON.stringify({
				machineId: "m_fork_move", cwd: "/tmp", forkFrom: worker,
			}) }, owner);
			const cmd = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-fork-session" && frame.id === worker);
			const moving = api(`/api/sessions/${worker}/namespace`, {
				method: "PUT", body: JSON.stringify({ namespaceId: destination, expectedVersion: 2 }),
			});
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true,
				data: { sessionFile: "/tmp/agent/sessions/fork-move.jsonl" } }));
			const created = await starting;
			expect(created.status).toBe(202);
			const { session } = await created.json() as { session: { id: string; namespaceId: string } };
			expect(session.namespaceId).toBe(original);
			await agent.take(frame => frame.t === "start" && frame.id === session.id);
			expect((await moving).status).toBe(200);
			expect(await (await api(`/api/sessions/${worker}`)).json()).toMatchObject({
				session: { namespaceId: destination },
			});
		} finally { agent.ws.close(); }
	});

	test("detaching an operator releases its workers for a new controller", async () => {
		const agent = await socket("m_controller_move");
		try {
			const namespaceId = await createNamespace("controller-transfer");
			const oldOwner = await live(agent, "m_controller_move", { superagent: true, namespaceId });
			const newOwner = await live(agent, "m_controller_move", { superagent: true, namespaceId });
			const worker = await live(agent, "m_controller_move", { namespaceId });
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, oldOwner)).status).toBe(200);
			const detached = await api(`/api/sessions/${oldOwner}/namespace`, {
				method: "PUT", body: JSON.stringify({ namespaceId: null, expectedVersion: 1 }),
			});
			expect(detached.status).toBe(200);
			const workerRecord = await (await api(`/api/sessions/${worker}`)).json();
			expect(workerRecord).toMatchObject({ session: { namespaceId, membershipVersion: 3 } });
			if (workerRecord && typeof workerRecord === "object" && "session" in workerRecord &&
				workerRecord.session && typeof workerRecord.session === "object") {
				expect("controllerId" in workerRecord.session && workerRecord.session.controllerId !== undefined).toBe(false);
			}
			expect((await api(`/api/fleet/sessions/${worker}/stop`, { method: "POST" }, oldOwner)).status).toBe(403);
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, newOwner)).status).toBe(200);
			expect(await (await api(`/api/sessions/${worker}`)).json()).toMatchObject({
				session: { controllerId: newOwner },
			});
		} finally { agent.ws.close(); }
	});

	test("deleting an operator frees its worker for another namespace peer", async () => {
		const agent = await socket("m_deleted_owner");
		try {
			const namespaceId = await createNamespace("operator-deleted");
			const owner = await live(agent, "m_deleted_owner", { superagent: true, namespaceId });
			const successor = await live(agent, "m_deleted_owner", { superagent: true, namespaceId });
			const worker = await live(agent, "m_deleted_owner", { namespaceId });
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, owner)).status).toBe(200);
			expect((await api(`/api/sessions/${owner}`, { method: "DELETE" })).status).toBe(200);
			await agent.take(frame => frame.t === "stop" && frame.id === owner);
			expect(await (await api(`/api/sessions/${worker}`)).json()).toMatchObject({
				session: { membershipVersion: 3 },
			});
			expect((await api(`/api/fleet/sessions/${worker}`, {}, owner)).status).toBe(403);
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, successor)).status).toBe(200);
		} finally { agent.ws.close(); }
	});

	test("mixed 0.12 and 0.13 daemons cannot exchange incompatible message cursors", async () => {
		const modern = await socket("m_tail_modern");
		const legacy = await socket("m_tail_legacy", "0.12.0");
		try {
			const namespaceId = await createNamespace("paging-upgrade");
			const modernOwner = await live(modern, "m_tail_modern", { superagent: true, namespaceId });
			const legacyWorker = await live(legacy, "m_tail_legacy", { namespaceId });
			const legacyWorkerRead = await api(`/api/fleet/sessions/${legacyWorker}/messages`, {}, modernOwner);
			expect(legacyWorkerRead.status).toBe(409);
			expect(await legacyWorkerRead.json()).toEqual({
				error: "fleet message paging requires agent 0.13.0+ on operator and worker machines",
			});

			const legacyOwner = await live(legacy, "m_tail_legacy", { superagent: true, namespaceId });
			const modernWorker = await live(modern, "m_tail_modern", { namespaceId });
			const legacyOwnerRead = await api(`/api/fleet/sessions/${modernWorker}/messages`, {}, legacyOwner);
			expect(legacyOwnerRead.status).toBe(409);
			expect(await legacyOwnerRead.json()).toEqual({
				error: "fleet message paging requires agent 0.13.0+ on operator and worker machines",
			});
		} finally {
			modern.ws.close();
			legacy.ws.close();
		}
	});

	test("moving a worker during an in-flight history read withholds the stale response", async () => {
		const agent = await socket("m_read_race");
		try {
			const firstNamespace = await createNamespace("read-scope-old");
			const nextNamespace = await createNamespace("read-scope-new");
			const owner = await live(agent, "m_read_race", { superagent: true, namespaceId: firstNamespace });
			const worker = await live(agent, "m_read_race", { namespaceId: firstNamespace });
			const reading = api(`/api/fleet/sessions/${worker}/messages?limit=1`, {}, owner);
			const cmd = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-get-messages" && frame.id === worker);
			const moved = await api(`/api/sessions/${worker}/namespace`, {
				method: "PUT", body: JSON.stringify({ namespaceId: nextNamespace, expectedVersion: 1 }),
			});
			expect(moved.status).toBe(200);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true,
				data: { messages: [{ id: "secret", role: "assistant", content: "private result" }], nextCursor: "secret", hasMore: false } }));
			const response = await reading;
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "session membership changed" });
		} finally { agent.ws.close(); }
	});

	test("fleet search cannot see another namespace or bypass the 0.14 operator/worker upgrade", async () => {
		const modern = await socket("m_search_modern", "0.14.0");
		const legacy = await socket("m_search_legacy", "0.13.0");
		try {
			const namespaceId = await createNamespace("search-upgrade");
			const privateNamespace = await createNamespace("search-private");
			const modernOwner = await live(modern, "m_search_modern", { superagent: true, namespaceId });
			const modernWorker = await live(modern, "m_search_modern", { namespaceId });
			const privateWorker = await live(modern, "m_search_modern", { namespaceId: privateNamespace });
			const legacyWorker = await live(legacy, "m_search_legacy", { namespaceId });
			const legacyOwner = await live(legacy, "m_search_legacy", { superagent: true, namespaceId });
			const forbidden = await api(`/api/fleet/sessions/${privateWorker}/search?query=secret`, {}, modernOwner);
			expect(forbidden.status).toBe(404);
			expect(await forbidden.json()).toEqual({ error: "session not found" });
			for (const [worker, owner] of [[legacyWorker, modernOwner], [modernWorker, legacyOwner]] as const) {
				const response = await api(`/api/fleet/sessions/${worker}/search?query=secret`, {}, owner);
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({
					error: "fleet message search requires agent 0.14.0+ on operator and worker machines",
				});
			}
			expect((await api(`/api/machines/m_search_modern/search?query=secret`, {}, modernOwner)).status).toBe(404);
		} finally {
			modern.ws.close();
			legacy.ws.close();
		}
	});

	test("fleet search rejects malformed ranges and parameters before reaching worker history", async () => {
		const agent = await socket("m_search_invalid", "0.14.0");
		try {
			const namespaceId = await createNamespace("search-invalid");
			const owner = await live(agent, "m_search_invalid", { superagent: true, namespaceId });
			const worker = await live(agent, "m_search_invalid", { namespaceId });
			const url = `/api/fleet/sessions/${worker}/search`;
			for (const suffix of [
				"", "?query=%20%20", `?query=${"a".repeat(257)}`,
				"?from=2026-02-30T12%3A00%3A00Z",
				"?to=2026-02-01T12%3A00%3A00",
				"?from=2026-02-01T12%3A00%3A00Z&to=2026-02-01T12%3A00%3A00Z",
				"?from=2026-02-02T12%3A00%3A00Z&to=2026-02-01T12%3A00%3A00Z",
				"?from=2026-09-30T10%3A00%3A00%2B02%3A00&to=2026-09-30T08%3A00%3A00Z",
				"?query=git&limit=51", `?query=git&cursor=${"x".repeat(129)}`,
				"?query=git&query=other", "?query=git&path=%2Fetc%2Fpasswd",
			]) {
				const response = await api(`${url}${suffix}`, {}, owner);
				expect(response.status).toBe(400);
			}
		} finally { agent.ws.close(); }
	});

	test("moving a worker mid-search never exposes old-namespace hits", async () => {
		const agent = await socket("m_search_race", "0.14.0");
		try {
			const oldNamespace = await createNamespace("search-race-old");
			const newNamespace = await createNamespace("search-race-new");
			const owner = await live(agent, "m_search_race", { superagent: true, namespaceId: oldNamespace });
			const worker = await live(agent, "m_search_race", { namespaceId: oldNamespace });
			const reading = api(`/api/fleet/sessions/${worker}/search?query=private`, {}, owner);
			const cmd = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-search-messages" && frame.id === worker);
			const moved = await api(`/api/sessions/${worker}/namespace`, {
				method: "PUT", body: JSON.stringify({ namespaceId: newNamespace, expectedVersion: 1 }),
			});
			expect(moved.status).toBe(200);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true, data: {
				hits: [{ id: "private", timestamp: "2026-09-30T12:00:00Z", role: "assistant", source: "text",
					snippet: "private result" }], nextCursor: "private", hasMore: false, leafId: "private",
			} }));
			const response = await reading;
			expect(response.status).toBe(409);
			expect(await response.text()).not.toContain("private result");
		} finally { agent.ws.close(); }
	});

	test("terminal search uses only the registered session file and reports history and stale-cursor failures", async () => {
		const agent = await socket("m_search_terminal", "0.14.0");
		try {
			const namespaceId = await createNamespace("search-terminal");
			const owner = await live(agent, "m_search_terminal", { superagent: true, namespaceId });
			const worker = await live(agent, "m_search_terminal", { namespaceId });
			agent.ws.send(JSON.stringify({ t: "session-exit", id: worker, code: 0, reason: "done" }));
			const deadline = Date.now() + 3000;
			for (;;) {
				const record = await (await api(`/api/sessions/${worker}`)).json() as { session: { status: string } };
				if (record.session.status === "exited") break;
				if (Date.now() > deadline) throw new Error("worker did not exit");
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			const url = `/api/fleet/sessions/${worker}/search`;
			const unreadable = api(`${url}?query=git%20merge&from=2026-09-30T00%3A00%3A00Z&limit=3`, {}, owner);
			const command = await agent.take(frame => frame.t === "cmd" && frame.cmd === "search-session-messages");
			expect(command).toMatchObject({ path: "/tmp/agent/sessions/test.jsonl",
				query: "git merge", from: "2026-09-30T00:00:00Z", pageLimit: 3 });
			expect(command.id).toBeUndefined();
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: command.reqId, ok: false, error: "could not open session history" }));
			const failure = await unreadable;
			expect(failure.status).toBe(502);
			expect(await failure.json()).toEqual({ error: "could not open session history" });
			const stale = api(`${url}?to=2026-09-30T00%3A00%3A00Z&cursor=old`, {}, owner);
			const next = await agent.take(frame => frame.t === "cmd" && frame.cmd === "search-session-messages" && frame.cursor === "old");
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: next.reqId, ok: false, error: "cursor is not on the active branch" }));
			const conflict = await stale;
			expect(conflict.status).toBe(409);
			expect(await conflict.json()).toEqual({ error: "cursor is not on the active branch" });
		} finally { agent.ws.close(); }
	});

	test("live reassignment revokes old controller and exposes pending input to the new controller", async () => {
		const agent = await socket("m_move");
		try {
			const oldNamespace = await createNamespace("move-old");
			const newNamespace = await createNamespace("move-new");
			const oldOwner = await live(agent, "m_move", { superagent: true, namespaceId: oldNamespace });
			const newOwner = await live(agent, "m_move", { superagent: true, namespaceId: newNamespace });
			const worker = await live(agent, "m_move", { namespaceId: oldNamespace });
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, oldOwner)).status).toBe(200);
			const watch = api(`/api/fleet/sessions/${worker}/watch`, { method: "POST", body: "{}" }, oldOwner);
			const firstInput = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-get-input" && frame.id === worker);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: firstInput.reqId, ok: true, data: { pending: [] } }));
			expect((await watch).status).toBe(200);
			const oldRecord = (await (await api(`/api/sessions/${worker}`)).json()) as { session: { membershipVersion: number } };
			const move = await api(`/api/sessions/${worker}/namespace`, { method: "PUT", body: JSON.stringify({ namespaceId: newNamespace, expectedVersion: oldRecord.session.membershipVersion }) });
			expect(move.status).toBe(200);
			expect((await api(`/api/fleet/sessions/${worker}`, {}, oldOwner)).status).toBe(404);
			expect((await api(`/api/fleet/sessions/${worker}/input`, { method: "POST", body: JSON.stringify({ requestId: "r1", answer: "yes" }) }, oldOwner)).status).toBe(404);
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, newOwner)).status).toBe(200);
			const nextWatch = api(`/api/fleet/sessions/${worker}/watch`, { method: "POST", body: "{}" }, newOwner);
			const input = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-get-input" && frame.id === worker);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: input.reqId, ok: true, data: { pending: [{ requestId: "r1", kind: "select", title: "Deploy?", options: ["yes", "no"] }] } }));
			expect((await nextWatch).status).toBe(200);
			const attached = await agent.take(frame => frame.t === "fleet-notification" && frame.id === newOwner &&
				typeof frame.event === "object" && frame.event !== null && "kind" in frame.event && frame.event.kind === "session_attached");
			expect(attached.event).toMatchObject({ sessionId: worker, kind: "session_attached" });
			const pushed = await agent.take(frame => frame.t === "fleet-notification" && frame.id === newOwner &&
				typeof frame.event === "object" && frame.event !== null && "kind" in frame.event && frame.event.kind === "input_required");
			expect(pushed.event).toMatchObject({ sessionId: worker, kind: "input_required", requestId: "r1" });
			const events = await (await api("/api/fleet/events", {}, newOwner)).json();
			expect(events).toMatchObject({ events: expect.arrayContaining([
				expect.objectContaining({ kind: "session_attached" }),
				expect.objectContaining({ kind: "input_required", requestId: "r1" }),
			]) });
		} finally { agent.ws.close(); }
	});

	test("a remote worker completion pushes once and remains in the inbox until acknowledged", async () => {
		const operatorMachine = await socket("m_operator");
		const workerMachine = await socket("m_worker");
		try {
			const namespaceId = await createNamespace("remote-work");
			const owner = await live(operatorMachine, "m_operator", { superagent: true, namespaceId });
			const worker = await live(workerMachine, "m_worker", { namespaceId });
			expect((await api(`/api/fleet/sessions/${worker}/claim`, { method: "POST" }, owner)).status).toBe(200);
			const watch = api(`/api/fleet/sessions/${worker}/watch`, { method: "POST", body: "{}" }, owner);
			const input = await workerMachine.take(frame => frame.t === "cmd" && frame.cmd === "fleet-get-input");
			workerMachine.ws.send(JSON.stringify({ t: "cmd-result", reqId: input.reqId, ok: true, data: { pending: [] } }));
			expect((await watch).status).toBe(200);
			const attached = await operatorMachine.take(frame => frame.t === "fleet-notification" && frame.id === owner &&
				typeof frame.event === "object" && frame.event !== null && "kind" in frame.event && frame.event.kind === "session_attached");
			expect(attached.event).toMatchObject({ kind: "session_attached", sessionId: worker });
			if (!attached.event || typeof attached.event !== "object" || !("id" in attached.event) || typeof attached.event.id !== "string") {
				throw new Error("attached notification lacked an event id");
			}
			expect((await api(`/api/fleet/events/${attached.event.id}/ack`, { method: "POST" }, owner)).status).toBe(200);
			const eventId = "evt_remote_1";
			workerMachine.ws.send(JSON.stringify({ t: "session-event", id: worker, eventId, kind: "turn_finished", leafId: "leaf" }));
			await workerMachine.take(frame => frame.t === "session-event-ack" && frame.eventId === eventId);
			const notification = await operatorMachine.take(frame => frame.t === "fleet-notification" && frame.id === owner &&
				typeof frame.event === "object" && frame.event !== null && "kind" in frame.event && frame.event.kind === "turn_finished");
			expect(notification.event).toMatchObject({ id: eventId, kind: "turn_finished", leafId: "leaf" });
			workerMachine.ws.send(JSON.stringify({ t: "session-event", id: worker, eventId, kind: "turn_finished", leafId: "leaf" }));
			await workerMachine.take(frame => frame.t === "session-event-ack" && frame.eventId === eventId);
			expect(await (await api("/api/fleet/events", {}, owner)).json()).toMatchObject({
				events: [{ id: eventId, kind: "turn_finished" }],
			});
			expect((await api(`/api/fleet/events/${eventId}/ack`, { method: "POST" }, owner)).status).toBe(200);
			expect(await (await api("/api/fleet/events", {}, owner)).json()).toEqual({ events: [] });
			// The first hub ack may be lost; a source retry after the owner ack
			// must not resurrect an already processed inbox entry.
			workerMachine.ws.send(JSON.stringify({ t: "session-event", id: worker, eventId, kind: "turn_finished", leafId: "leaf" }));
			await workerMachine.take(frame => frame.t === "session-event-ack" && frame.eventId === eventId);
			expect(await (await api("/api/fleet/events", {}, owner)).json()).toEqual({ events: [] });
			workerMachine.ws.send(JSON.stringify({ t: "session-event", id: worker, eventId: "evt_failure",
				kind: "operation_failed", operationId: "op_message", error: "provider rejected request" }));
			await workerMachine.take(frame => frame.t === "session-event-ack" && frame.eventId === "evt_failure");
			const failure = await operatorMachine.take(frame => frame.t === "fleet-notification" && frame.id === owner);
			expect(failure.event).toMatchObject({ kind: "operation_failed", operationId: "op_message", error: "provider rejected request" });
		} finally { operatorMachine.ws.close(); workerMachine.ws.close(); }
	});

	test("terminal notifications survive one failed inbox commit and retry with the same id", async () => {
		const agent = await socket("m_terminal_retry");
		const originalEnqueue = hub.fleet.enqueue;
		try {
			const namespaceId = await createNamespace("terminal-retry");
			const owner = await live(agent, "m_terminal_retry", { superagent: true, namespaceId });
			const worker = await live(agent, "m_terminal_retry", { namespaceId });
			const watched = api(`/api/fleet/sessions/${worker}/watch`, { method: "POST", body: "{}" }, owner);
			const input = await agent.take(frame => frame.t === "cmd" && frame.cmd === "fleet-get-input" && frame.id === worker);
			agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: input.reqId, ok: true, data: { pending: [] } }));
			expect((await watched).status).toBe(200);
			let failed = false;
			hub.fleet.enqueue = (event: FleetEvent, eligible: (ownerId: string) => boolean): string[] => {
				if (!failed && event.kind === "session_exited") {
					failed = true;
					throw new Error("transient fleet disk error");
				}
				return originalEnqueue.call(hub.fleet, event, eligible);
			};
			const terminalEventId = "terminal_stable";
			agent.ws.send(JSON.stringify({ t: "session-exit", id: worker, code: 0, reason: "done", eventId: terminalEventId }));
			const deadline = Date.now() + 3000;
			for (;;) {
				const payload: unknown = await (await api(`/api/sessions/${worker}`)).json();
				if (payload && typeof payload === "object" && "session" in payload &&
					payload.session && typeof payload.session === "object" && "status" in payload.session &&
					payload.session.status === "exited") break;
				if (Date.now() > deadline) throw new Error("worker did not exit");
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			expect(failed).toBe(true);
			hub.agents.retryFleetEvents();
			const delivered = await agent.take(frame => frame.t === "fleet-notification" && frame.id === owner &&
				typeof frame.event === "object" && frame.event !== null && "kind" in frame.event && frame.event.kind === "session_exited");
			expect(delivered.event).toMatchObject({ id: terminalEventId, kind: "session_exited", sessionId: worker });
			hub.agents.retryFleetEvents();
			const unread = await (await api("/api/fleet/events", {}, owner)).json();
			if (!unread || typeof unread !== "object" || !("events" in unread) || !Array.isArray(unread.events)) {
				throw new Error("missing unread fleet event list");
			}
			expect(unread.events.filter((event: unknown) =>
				event !== null && typeof event === "object" && "kind" in event && event.kind === "session_exited")).toHaveLength(1);
			expect((await api(`/api/fleet/events/${terminalEventId}/ack`, { method: "POST" }, owner)).status).toBe(200);
			agent.ws.send(JSON.stringify({ t: "session-event", id: worker, eventId: terminalEventId, kind: "session_exited" }));
			await agent.take(frame => frame.t === "session-event-ack" && frame.eventId === terminalEventId);
			const afterRetry = await (await api("/api/fleet/events", {}, owner)).json();
			if (!afterRetry || typeof afterRetry !== "object" || !("events" in afterRetry) || !Array.isArray(afterRetry.events)) {
				throw new Error("missing unread fleet event list after retry");
			}
			expect(afterRetry.events.some((event: unknown) =>
				event !== null && typeof event === "object" && "kind" in event && event.kind === "session_exited")).toBe(false);
		} finally {
			hub.fleet.enqueue = originalEnqueue;
			agent.ws.close();
		}
	});

});

test("hub restart restores namespace membership and unacknowledged supervision events", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "fleet-persistence-"));
	const stateFile = path.join(dir, "state.json");
	const first = startHub({ port: 0, hostname: "127.0.0.1", token: "fleet-test", stateFile });
	let firstClosed = false;
	let restored: Hub | undefined;
	try {
		const namespace = first.fleet.createNamespace("persistent", null);
		const operator = first.sessions.create({ machineId: "m", machineName: "machine", cwd: "/tmp", superagent: true });
		first.sessions.applyMembership(operator.id, first.fleet.assign(operator.id, namespace.id)!);
		const worker = first.sessions.create({ machineId: "m", machineName: "machine", cwd: "/tmp" });
		first.sessions.applyMembership(worker.id, first.fleet.assign(worker.id, namespace.id)!);
		first.sessions.applyMembership(worker.id, first.fleet.claim(worker.id, operator.id)!);
		first.fleet.watch(operator.id, worker.id);
		first.fleet.enqueueFor(operator.id, { id: "durable_input", sessionId: worker.id,
			kind: "input_required", requestId: "request-one", createdAt: Date.now() });
		const processedSource = { id: "completed_once", sessionId: worker.id, kind: "turn_finished", createdAt: Date.now() };
		expect(first.fleet.enqueue(processedSource, candidate => candidate === operator.id)).toEqual([operator.id]);
		expect(first.fleet.ack(operator.id, processedSource.id)).toBe(true);
		await first.core.shutdown();
		first.server.stop(true);
		firstClosed = true;

		restored = startHub({ port: 0, hostname: "127.0.0.1", token: "fleet-test", stateFile });
		const recordReply = await fetch(`${restored.url}/api/sessions/${worker.id}`, { headers: { authorization: "Bearer fleet-test" } });
		expect(recordReply.status).toBe(200);
		expect(await recordReply.json()).toMatchObject({ session: {
			namespaceId: namespace.id, controllerId: operator.id, membershipVersion: 2,
		} });
		const namespaceReply = await fetch(`${restored.url}/api/namespaces`, { headers: { authorization: "Bearer fleet-test" } });
		expect(await namespaceReply.json()).toMatchObject({ namespaces: [{ id: namespace.id, name: "persistent" }] });
		expect(restored.fleet.events(operator.id)).toMatchObject([
			{ id: "durable_input", sessionId: worker.id, kind: "input_required", requestId: "request-one" },
		]);
		expect(restored.fleet.enqueue(processedSource, candidate => candidate === operator.id)).toEqual([]);
		expect(restored.fleet.events(operator.id)).toMatchObject([
			{ id: "durable_input", sessionId: worker.id, kind: "input_required" },
		]);
	} finally {
		if (restored) {
			await restored.core.shutdown();
			restored.server.stop(true);
		}
		if (!firstClosed) {
			await first.core.shutdown();
			first.server.stop(true);
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
