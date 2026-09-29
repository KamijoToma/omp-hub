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

async function socket(machineId: string): Promise<{ ws: WebSocket; take(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> }> {
	const ws = new WebSocket(`${hub.url.replace(/^http/, "ws")}/agent`, { headers: { authorization: "Bearer fleet-test" } });
	const frames: Record<string, unknown>[] = [];
	ws.addEventListener("message", event => {
		if (typeof event.data === "string") frames.push(JSON.parse(event.data) as Record<string, unknown>);
	});
	const ready = Promise.withResolvers<void>();
	ws.addEventListener("open", () => ready.resolve(), { once: true });
	ws.addEventListener("error", () => ready.reject(new Error("socket failed")), { once: true });
	await ready.promise;
	ws.send(JSON.stringify({ t: "hello", machineId, name: machineId, version: "0.12.0" }));
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
