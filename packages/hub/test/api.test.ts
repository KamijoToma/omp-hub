/**
 * API + agent-channel contract (docs/protocol.md §2/§3) against a hub started in-process
 * on an ephemeral port, with a fake agent daemon over a real WebSocket.
 *
 * Waits are condition-based (they yield the event loop instead of sleeping a fixed
 * duration), so the suite has no wall-clock latency of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHub, type Hub } from "../src/server";

interface SessionJson {
	id: string;
	machineId: string;
	machineName: string;
	cwd: string;
	name: string;
	profile?: string;
	status: string;
	startedAt: number;
	exitedAt?: number;
	exitReason?: string;
	error?: string;
	links?: { full: string; view: string; web: string; webView: string };
	sessionFile?: string;
	pid?: number;
}

interface MachineJson {
	machineId: string;
	name: string;
	connected: boolean;
	connectedAt: number;
	sessionCount: number;
	tmpdir?: string;
}

/** Yields the event loop so pending socket I/O can be processed (no fixed delay). */
const yieldLoop = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

let hub: Hub;
let httpBase: string;
let wsBase: string;

beforeAll(() => {
	hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	httpBase = hub.url;
	wsBase = hub.url.replace(/^http/, "ws");
});

afterAll(() => {
	hub.stop();
});

const AUTH = { authorization: "Bearer t", "content-type": "application/json" };

function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${httpBase}${path}`, { headers: AUTH, ...init });
}

async function sessionJson(id: string): Promise<SessionJson> {
	const response = await api(`/api/sessions/${id}`);
	expect(response.status).toBe(200);
	return ((await response.json()) as { session: SessionJson }).session;
}

async function machinesJson(): Promise<MachineJson[]> {
	const response = await api("/api/machines");
	expect(response.status).toBe(200);
	return ((await response.json()) as { machines: MachineJson[] }).machines;
}

/** Polls the API until the record reaches `status`; the hub flips it on agent reports. */
async function waitForStatus(id: string, status: string): Promise<SessionJson> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const session = await sessionJson(id);
		if (session.status === status) return session;
		if (Date.now() > deadline) throw new Error(`session ${id} stayed "${session.status}", expected "${status}"`);
		await yieldLoop();
	}
}

async function waitForMachine(machineId: string, connected: boolean): Promise<MachineJson> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const machine = (await machinesJson()).find((record) => record.machineId === machineId);
		if (machine?.connected === connected) return machine;
		if (Date.now() > deadline) throw new Error(`machine ${machineId} never reached connected=${connected}`);
		await yieldLoop();
	}
}

interface FakeAgent {
	readonly ws: WebSocket;
	readonly frames: Record<string, unknown>[];
	/** Waits for the next frame matching the predicate, skipping unmatched earlier frames. */
	wait<T>(match: (frame: Record<string, unknown>) => T | undefined, what: string): Promise<T>;
}

async function connectAgent(
	machineId: string,
	name: string,
	extra: Record<string, unknown> = {},
): Promise<{ agent: FakeAgent; welcome: Record<string, unknown> }> {
	const ws = new WebSocket(`${wsBase}/agent?token=t`);
	const frames: Record<string, unknown>[] = [];
	let cursor = 0;
	ws.addEventListener("message", (event: MessageEvent) => {
		if (typeof event.data === "string") frames.push(JSON.parse(event.data) as Record<string, unknown>);
	});
	const opened = Promise.withResolvers<void>();
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("error", () => opened.reject(new Error("agent socket error")), { once: true });
	await opened.promise;

	const wait = async <T>(match: (frame: Record<string, unknown>) => T | undefined, what: string): Promise<T> => {
		const deadline = Date.now() + 4_000;
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

	ws.send(JSON.stringify({ t: "hello", name, machineId, version: "test", ...extra }));
	const welcome = await wait((frame) => (frame.t === "welcome" ? frame : undefined), "welcome");
	return { agent: { ws, frames, wait }, welcome };
}

async function startSession(machineId: string, cwd: string, extra: Record<string, unknown> = {}): Promise<SessionJson> {
	const response = await api("/api/sessions", { method: "POST", body: JSON.stringify({ machineId, cwd, ...extra }) });
	expect(response.status).toBe(202);
	return ((await response.json()) as { session: SessionJson }).session;
}

describe("hub api", () => {
	test("health is public; every other route needs the bearer token", async () => {
		const health = await fetch(`${httpBase}/api/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true, version: hub.cfg.version });

		const anon = await fetch(`${httpBase}/api/machines`);
		expect(anon.status).toBe(401);
		expect(await anon.json()).toEqual({ error: "unauthorized" });

		const wrong = await fetch(`${httpBase}/api/sessions`, { headers: { authorization: "Bearer nope" } });
		expect(wrong.status).toBe(401);
	});

	test("hello registers a machine and answers welcome with the derived links", async () => {
		const wrongToken = await fetch(`${httpBase}/agent?token=nope`);
		expect(wrongToken.status).toBe(401);

		const { welcome } = await connectAgent("m-hello", "hello-machine");
		expect(welcome.relayUrl).toBe(wsBase);
		expect(welcome.webUrl).toBe(httpBase);

		expect(await machinesJson()).toEqual([
			{ machineId: "m-hello", name: "hello-machine", connected: true, connectedAt: expect.any(Number), sessionCount: 0 },
		]);
	});

	test("hello.tmpdir surfaces in the machine record", async () => {
		await connectAgent("m-tmp", "tmp-machine", { tmpdir: "/var/tmp" });
		const machine = (await machinesJson()).find((record) => record.machineId === "m-tmp");
		expect(machine).toEqual({
			machineId: "m-tmp",
			name: "tmp-machine",
			connected: true,
			connectedAt: expect.any(Number),
			sessionCount: 0,
			tmpdir: "/var/tmp",
		});
	});

	test("POST /api/sessions dispatches start and session-ready attaches the links", async () => {
		const { agent } = await connectAgent("m-start", "start-machine");

		const session = await startSession("m-start", "/srv/projects/demo");
		expect(session.status).toBe("starting");
		expect(session.id).toMatch(/^s_[0-9a-z]{10}$/);
		expect(session.name).toBe("demo");
		expect(session.machineName).toBe("start-machine");

		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect(start).toMatchObject({
			id: session.id,
			cwd: "/srv/projects/demo",
			name: "demo",
			relayUrl: wsBase,
			webUrl: httpBase,
		});
		expect((await waitForMachine("m-start", true)).sessionCount).toBe(1);

		const links = {
			full: "wss://relay.example/r/room#write",
			view: "wss://relay.example/r/room#view",
			web: "https://relay.example/#write",
			webView: "https://relay.example/#view",
		};
		agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, sessionFile: "/tmp/s.jsonl", pid: 4242, links }));

		const live = await waitForStatus(session.id, "live");
		expect(live.links).toEqual(links);
		expect(live.sessionFile).toBe("/tmp/s.jsonl");
		expect(live.pid).toBe(4242);

		const listed = (await (await api("/api/sessions")).json()) as { sessions: SessionJson[] };
		expect(listed.sessions.map((record) => record.id)).toEqual([session.id]);
	});

	test("stop forwards to the agent, session-exit flips the record, a finished session is 409", async () => {
		const { agent } = await connectAgent("m-stop", "stop-machine");
		const session = await startSession("m-stop", "/srv/other", { name: "custom", prompt: "say hi" });

		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect(start).toMatchObject({ id: session.id, name: "custom", prompt: "say hi" });
		agent.ws.send(
			JSON.stringify({ t: "session-ready", id: session.id, links: { full: "a", view: "b", web: "c", webView: "d" } }),
		);
		await waitForStatus(session.id, "live");

		const stopped = await api(`/api/sessions/${session.id}/stop`, { method: "POST" });
		expect(stopped.status).toBe(200);
		expect(await stopped.json()).toEqual({ ok: true });
		expect(await agent.wait((frame) => (frame.t === "stop" ? frame : undefined), "stop frame")).toMatchObject({
			id: session.id,
			reason: "user stop",
		});

		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "user stop" }));
		const exited = await waitForStatus(session.id, "exited");
		expect(exited.exitReason).toBe("user stop");
		expect(exited.exitedAt).toBeGreaterThan(0);

		const again = await api(`/api/sessions/${session.id}/stop`, { method: "POST" });
		expect(again.status).toBe(409);

		const missing = await api("/api/sessions/s_0000000000/stop", { method: "POST" });
		expect(missing.status).toBe(404);
	});

	test("session-error flips the record to failed with the error", async () => {
		const { agent } = await connectAgent("m-fail", "fail-machine");
		const session = await startSession("m-fail", "/srv/boom");
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");

		agent.ws.send(JSON.stringify({ t: "session-error", id: session.id, error: "spawn failed" }));
		const failed = await waitForStatus(session.id, "failed");
		expect(failed.error).toBe("spawn failed");
	});

	test("start.profile is forwarded to the agent and echoed on the record", async () => {
		const { agent } = await connectAgent("m-prof", "prof-machine");

		const session = await startSession("m-prof", "/srv/profiled", { profile: "work" });
		expect(session.profile).toBe("work");
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect(start).toMatchObject({ id: session.id, profile: "work" });
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "done" }));
	});

	test("profile \"default\" selects the implicit default: no profile on the wire or record", async () => {
		const { agent } = await connectAgent("m-prof-def", "prof-def-machine");

		const session = await startSession("m-prof-def", "/srv/defaulted", { profile: "default" });
		expect(session.profile).toBeUndefined();
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect("profile" in start).toBe(false);
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "done" }));
	});

	test("an invalid profile name is rejected with 400 before any record exists", async () => {
		await connectAgent("m-prof-bad", "prof-bad-machine");

		const response = await api("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ machineId: "m-prof-bad", cwd: "/srv/x", profile: "Work.." }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: expect.stringContaining('Invalid OMP profile "Work.."'),
		});

		const listed = (await (await api("/api/sessions")).json()) as { sessions: SessionJson[] };
		expect(listed.sessions.find((record) => record.machineId === "m-prof-bad")).toBeUndefined();
	});

	test("agent disconnect drops the machine to connected:false and exits its sessions", async () => {
		const { agent } = await connectAgent("m-drop", "drop-machine");
		const session = await startSession("m-drop", "/srv/dropped");
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");

		agent.ws.close();
		const exited = await waitForStatus(session.id, "exited");
		expect(exited.exitReason).toBe("agent disconnected");
		expect(await waitForMachine("m-drop", false)).toEqual({
			machineId: "m-drop",
			name: "drop-machine",
			connected: false,
			connectedAt: expect.any(Number),
			sessionCount: 0,
		});

		// A known but offline machine cannot start sessions.
		const offline = await api("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ machineId: "m-drop", cwd: "/srv/again" }),
		});
		expect(offline.status).toBe(404);
		expect(await offline.json()).toEqual({ error: "machine offline" });
	});

	test("a new connection with the same machineId replaces the old one", async () => {
		const first = await connectAgent("m-dup", "dup-machine");
		const session = await startSession("m-dup", "/srv/dup");
		await first.agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");

		const second = await connectAgent("m-dup", "dup-machine");
		const replaced = await waitForStatus(session.id, "exited");
		expect(replaced.exitReason).toBe("agent replaced");
		expect(second.welcome.relayUrl).toBe(wsBase);
		expect(await waitForMachine("m-dup", true)).toMatchObject({ sessionCount: 0, name: "dup-machine" });

		second.agent.ws.close();
	});

	test("POST /api/sessions forwards sessionFile and rejects empty resume targets", async () => {
		const { agent } = await connectAgent("m-resume", "resume-machine");
		const sessionFile = "/home/dev/project/.omp/sessions/20260627_resume01.jsonl";

		const session = await startSession("m-resume", "/home/dev/project", { sessionFile });
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		// The resume target rides the start frame untouched; without it the
		// field stays absent so ordinary starts see an unchanged frame.
		expect(start).toMatchObject({ id: session.id, cwd: "/home/dev/project", sessionFile });
		agent.ws.close(1000, "test done");

		const other = await connectAgent("m-resume-plain", "resume-plain-machine");
		const plain = await startSession("m-resume-plain", "/srv/app");
		const plainStart = await other.agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect("sessionFile" in plainStart).toBe(false);
		expect(plain.cwd).toBe("/srv/app");

		const empty = await api("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ machineId: "m-resume-plain", cwd: "/srv/app", sessionFile: "  " }),
		});
		expect(empty.status).toBe(400);
		expect(await empty.json()).toEqual({ error: "sessionFile must be a non-empty string" });
	});

	test("validation: unknown machine and missing fields", async () => {
		const unknown = await api("/api/sessions", { method: "POST", body: JSON.stringify({ machineId: "ghost", cwd: "/tmp/x" }) });
		expect(unknown.status).toBe(404);

		const noCwd = await api("/api/sessions", { method: "POST", body: JSON.stringify({ machineId: "ghost" }) });
		expect(noCwd.status).toBe(400);

		const emptyCwd = await api("/api/sessions", { method: "POST", body: JSON.stringify({ machineId: "ghost", cwd: "  " }) });
		expect(emptyCwd.status).toBe(400);

		const unknownSession = await api("/api/sessions/s_zzzzzzzzzz");
		expect(unknownSession.status).toBe(404);

		const badRoute = await api("/api/nope");
		expect(badRoute.status).toBe(404);

		const badJson = await api("/api/sessions", { method: "POST", body: "{" });
		expect(badJson.status).toBe(400);
	});
});
