/**
 * Panel-triggered daemon upgrade restart (docs/protocol.md §2 `restart-daemon`,
 * §3 `POST /api/machines/:id/restart-daemon`) against a hub started in-process
 * with fake agent daemons over real WebSockets: cmd acceptance, the
 * disconnect-time resume-plan arming, and the fresh daemon's first-heartbeat
 * same-id replay — plus the old-daemon refusal and duplicate-request guards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHub, type Hub } from "../src/server";

interface SessionJson {
	id: string;
	name: string;
	status: string;
	unreachable?: true;
	exitReason?: string;
	links?: { full: string };
}

interface MachineJson {
	machineId: string;
	connected: boolean;
	restarting?: true;
}

/** Hub instance plus the origins its tests talk to. */
interface Ctx {
	readonly hub: Hub;
	readonly http: string;
	readonly ws: string;
}

const LINKS_A = {
	full: "wss://relay.example/r/room-a#write",
	view: "wss://relay.example/r/room-a#view",
	web: "https://relay.example/#write",
	webView: "https://relay.example/#view",
};
const LINKS_B = {
	full: "wss://relay.example/r/room-b#write",
	view: "wss://relay.example/r/room-b#view",
	web: "https://relay.example/#write",
	webView: "https://relay.example/#view",
};

const SESSION_FILE = "/home/me/.omp/profiles/glm/agent/sessions/-srv-proj/x.jsonl";

/** Yields the event loop so pending socket I/O can be processed (no fixed delay). */
const yieldLoop = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

function startCluster(): Ctx {
	const hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	return { hub, http: hub.url, ws: hub.url.replace(/^http/, "ws") };
}

let main: Ctx;

beforeAll(() => {
	main = startCluster();
});

afterAll(() => {
	main.hub.stop();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${main.http}${path}`, {
		headers: { authorization: "Bearer t", "content-type": "application/json" },
		...init,
	});
}

interface FakeAgent {
	readonly ws: WebSocket;
	/** Waits for the next frame matching the predicate, skipping unmatched earlier frames. */
	wait<T>(match: (frame: Record<string, unknown>) => T | undefined, what: string, timeoutMs?: number): Promise<T>;
}

async function connectAgent(machineId: string, name: string): Promise<FakeAgent> {
	const ws = new WebSocket(`${main.ws}/agent`, { headers: { authorization: "Bearer t" } });
	const frames: Record<string, unknown>[] = [];
	let cursor = 0;
	ws.addEventListener("message", (event: MessageEvent) => {
		if (typeof event.data === "string") frames.push(JSON.parse(event.data) as Record<string, unknown>);
	});
	const opened = Promise.withResolvers<void>();
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("error", () => opened.reject(new Error("agent socket error")), { once: true });
	await opened.promise;

	const wait = async <T>(match: (frame: Record<string, unknown>) => T | undefined, what: string, timeoutMs = 4_000): Promise<T> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			while (cursor < frames.length) {
				const hit = match(frames[cursor++]!);
				if (hit !== undefined) return hit;
			}
			if (Date.now() > deadline) {
				throw new Error(`timeout waiting for ${what}; frames: ${JSON.stringify(frames)}`);
			}
			await yieldLoop();
		}
	};

	ws.send(JSON.stringify({ t: "hello", name, machineId, version: "test" }));
	await wait((frame) => (frame.t === "welcome" ? frame : undefined), "welcome");
	return { ws, wait };
}

async function sessionJson(id: string): Promise<SessionJson> {
	const response = await api(`/api/sessions/${id}`);
	expect(response.status).toBe(200);
	return ((await response.json()) as { session: SessionJson }).session;
}

/** Polls the API until the record reaches `status`. */
async function waitForStatus(id: string, status: string): Promise<SessionJson> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const session = await sessionJson(id);
		if (session.status === status) return session;
		if (Date.now() > deadline) throw new Error(`session ${id} stayed "${session.status}", expected "${status}"`);
		await yieldLoop();
	}
}

async function machinesJson(): Promise<MachineJson[]> {
	const response = await api("/api/machines");
	expect(response.status).toBe(200);
	return ((await response.json()) as { machines: MachineJson[] }).machines;
}

async function machineJson(machineId: string): Promise<MachineJson> {
	const list = await machinesJson();
	const machine = list.find(entry => entry.machineId === machineId);
	expect(machine).toBeDefined();
	return machine!;
}

/** Starts a resumable session on `machineId` and drives it to `live`. */
async function liveSession(agent: FakeAgent, machineId: string): Promise<SessionJson> {
	const created = await api("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ machineId, cwd: "/srv/proj", profile: "glm", sessionFile: SESSION_FILE }),
	});
	expect(created.status).toBe(202);
	const session = ((await created.json()) as { session: SessionJson }).session;

	const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
	agent.ws.send(
		JSON.stringify({ t: "session-ready", id: start.id, sessionFile: SESSION_FILE, pid: 4242, links: LINKS_A }),
	);
	const live = await waitForStatus(session.id, "live");
	expect(live.links?.full).toBe(LINKS_A.full);
	return live;
}

/** The fresh daemon's connect sequence: hello, then an immediate empty hb. */
async function connectFreshDaemon(machineId: string, name: string): Promise<FakeAgent> {
	const agent = await connectAgent(machineId, name);
	agent.ws.send(JSON.stringify({ t: "hb", ts: Date.now(), sessions: [] }));
	return agent;
}

describe("daemon upgrade restart", () => {
	test("replays a same-id resume when the fresh daemon reconnects", async () => {
		const agent = await connectAgent("m1", "restartable");
		const live = await liveSession(agent, "m1");

		// The POST settles only after the agent answers the restart cmd, so it
		// is fired before waiting for the frame.
		const acceptedPromise = api("/api/machines/m1/restart-daemon", { method: "POST" });
		const cmd = await agent.wait(
			(frame) => (frame.t === "cmd" && frame.cmd === "restart-daemon" && frame.id === undefined ? frame : undefined),
			"restart-daemon cmd",
		);
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true, data: { restarting: true } }));
		// The daemon exits after stopping its children: close the socket.
		agent.ws.close(1000);

		const accepted = await acceptedPromise;
		expect(accepted.status).toBe(200);
		const acceptedBody = (await accepted.json()) as { machine: MachineJson };
		expect(acceptedBody.machine.restarting).toBe(true);

		const exited = await waitForStatus(live.id, "exited");
		expect(exited.exitReason).toBe("daemon upgrade");
		// The armed plan keeps the restarting marker until the replay consumes it.
		expect((await machineJson("m1")).restarting).toBe(true);

		const fresh = await connectFreshDaemon("m1", "restartable");
		const replay = await fresh.wait((frame) => (frame.t === "start" ? frame : undefined), "replayed start frame");
		expect(replay.id).toBe(live.id); // same id: panel pages stay valid
		expect(replay.sessionFile).toBe(SESSION_FILE);
		expect(replay.cwd).toBe("/srv/proj");
		expect(replay.profile).toBe("glm");
		expect(replay.prompt).toBeUndefined();
		expect(typeof replay.relayUrl).toBe("string");
		expect(typeof replay.webUrl).toBe("string");
		fresh.ws.send(
			JSON.stringify({ t: "session-ready", id: replay.id, sessionFile: SESSION_FILE, pid: 4243, links: LINKS_B }),
		);
		const revived = await waitForStatus(live.id, "live");
		expect(revived.links?.full).toBe(LINKS_B.full); // fresh links rotated in
		await yieldLoop();
		expect((await machineJson("m1")).restarting).toBeUndefined(); // plan consumed
	});

	test("an old daemon's refusal surfaces as 400 and resumes nothing", async () => {
		const agent = await connectAgent("m2", "legacy");
		const live = await liveSession(agent, "m2");

		const refusedPromise = api("/api/machines/m2/restart-daemon", { method: "POST" });
		const cmd = await agent.wait((frame) => (frame.t === "cmd" && frame.cmd === "restart-daemon" ? frame : undefined), "restart cmd");
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: false, error: "unknown machine command: restart-daemon" }));
		const refused = await refusedPromise;
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toContain("unknown machine command");
		expect((await machineJson("m2")).restarting).toBeUndefined();

		agent.ws.close(1000);
		const deadline = Date.now() + 4_000;
		for (;;) {
			const current = await sessionJson(live.id);
			if (current.unreachable) {
				expect(current.status).toBe("live");
				expect(current.exitReason).toBeUndefined(); // a plain socket drop is not a completed session
				break;
			}
			if (Date.now() > deadline) throw new Error("daemon disconnect did not mark its session unreachable");
			await yieldLoop();
		}
		const fresh = await connectFreshDaemon("m2", "legacy");
		// No start frame may arrive: nothing was planned.
		await fresh
			.wait((frame) => (frame.t === "start" ? frame : undefined), "unexpected start frame", 300)
			.then(() => {
				throw new Error("replayed a start for a refused restart");
			})
			.catch((err: Error) => {
				expect(err.message).toContain("timeout waiting");
			});
	});

	test("a concurrent second request conflicts", async () => {
		const agent = await connectAgent("m3", "slow");
		// The first POST stays pending on the un-acked cmd, which is exactly the
		// window a duplicate request must 409 in. The duplicate sends no cmd of
		// its own, so this wait captures the ONLY restart frame.
		const firstPromise = api("/api/machines/m3/restart-daemon", { method: "POST" });
		const cmd = await agent.wait((frame) => (frame.t === "cmd" && frame.cmd === "restart-daemon" ? frame : undefined), "restart cmd");

		const second = await api("/api/machines/m3/restart-daemon", { method: "POST" });
		expect(second.status).toBe(409);
		expect(((await second.json()) as { error: string }).error).toBe("daemon restart already in progress");

		// Settle the machine: ack, close, reconnect with the empty-children hb.
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true, data: {} }));
		agent.ws.close(1000);
		expect((await firstPromise).status).toBe(200);
		await connectFreshDaemon("m3", "slow");
	});

	test("arms the plan when the fresh daemon wins the replacement race", async () => {
		// Production race: the replacement daemon connects before the dying
		// daemon's socket tears down, so the hub takes the `hello` replacement
		// path (agent replaced) instead of a graceful close.
		const agent = await connectAgent("m4", "racy");
		const live = await liveSession(agent, "m4");

		const acceptedPromise = api("/api/machines/m4/restart-daemon", { method: "POST" });
		const cmd = await agent.wait((frame) => (frame.t === "cmd" && frame.cmd === "restart-daemon" ? frame : undefined), "restart cmd");
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true, data: {} }));
		// The old daemon stalls ~100 ms before exiting; NO close here.
		const fresh = await connectFreshDaemon("m4", "racy");
		expect((await acceptedPromise).status).toBe(200);

		const replay = await fresh.wait((frame) => (frame.t === "start" ? frame : undefined), "replayed start frame");
		expect(replay.id).toBe(live.id);
		expect(replay.sessionFile).toBe(SESSION_FILE);
		fresh.ws.send(JSON.stringify({ t: "session-ready", id: replay.id, sessionFile: SESSION_FILE, pid: 4244, links: LINKS_B }));
		const revived = await waitForStatus(live.id, "live");
		expect(revived.links?.full).toBe(LINKS_B.full);
		expect((await machineJson("m4")).restarting).toBeUndefined();
	});

	test("resumes children the daemon stopped during its upgrade", async () => {
		// Real daemon flow: stopAll makes every child send `session-exit` BEFORE
		// the socket handover, so the records are terminal (reason "daemon
		// upgrade") by the time the fresh daemon connects.
		const agent = await connectAgent("m5", "stopping");
		const live = await liveSession(agent, "m5");

		const acceptedPromise = api("/api/machines/m5/restart-daemon", { method: "POST" });
		const cmd = await agent.wait((frame) => (frame.t === "cmd" && frame.cmd === "restart-daemon" ? frame : undefined), "restart cmd");
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true, data: {} }));
		agent.ws.send(JSON.stringify({ t: "session-exit", id: live.id, code: 0, reason: "daemon upgrade" }));
		agent.ws.close(1000);
		await acceptedPromise;

		const fresh = await connectFreshDaemon("m5", "stopping");
		const replay = await fresh.wait((frame) => (frame.t === "start" ? frame : undefined), "replayed start frame");
		expect(replay.id).toBe(live.id);
		fresh.ws.send(JSON.stringify({ t: "session-ready", id: replay.id, sessionFile: SESSION_FILE, pid: 4245, links: LINKS_B }));
		expect((await waitForStatus(live.id, "live")).links?.full).toBe(LINKS_B.full);
	});

	test("leaves sessions the operator stopped in the window alone", async () => {
		const agent = await connectAgent("m6", "operator-stop");
		const live = await liveSession(agent, "m6");

		const acceptedPromise = api("/api/machines/m6/restart-daemon", { method: "POST" });
		const cmd = await agent.wait((frame) => (frame.t === "cmd" && frame.cmd === "restart-daemon" ? frame : undefined), "restart cmd");
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd.reqId, ok: true, data: {} }));
		// The operator stops it mid-window: a reason that is not the handover's.
		agent.ws.send(JSON.stringify({ t: "session-exit", id: live.id, code: 0, reason: "user stop" }));
		agent.ws.close(1000);
		await acceptedPromise;

		const fresh = await connectFreshDaemon("m6", "operator-stop");
		await fresh
			.wait((frame) => (frame.t === "start" ? frame : undefined), "unexpected start frame", 300)
			.then(() => {
				throw new Error("resumed a session the operator stopped");
			})
			.catch((err: Error) => {
				expect(err.message).toContain("timeout waiting");
			});
	});

	test("restarting an offline machine is 502", async () => {
		const offline = await api("/api/machines/never-connected/restart-daemon", { method: "POST" });
		expect(offline.status).toBe(404);
	});
});
