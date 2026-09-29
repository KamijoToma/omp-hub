/**
 * API + agent-channel contract (docs/protocol.md §2/§3) against a hub started in-process
 * on an ephemeral port, with a fake agent daemon over a real WebSocket.
 *
 * Waits are condition-based (they yield the event loop instead of sleeping a fixed
 * duration), so the suite has no wall-clock latency of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, type Hub } from "../src/server";

interface SessionJson {
	id: string;
	machineId: string;
	machineName: string;
	cwd: string;
	name: string;
	profile?: string;
	tools?: string[];
	status: string;
	unreachable?: true;
	startedAt: number;
	exitedAt?: number;
	exitReason?: string;
	error?: string;
	links?: { full: string; view: string; web: string; webView: string };
	sessionFile?: string;
	pid?: number;
	activity?: { working: boolean; inputRequired: boolean; handoff?: boolean; updatedAt: number };
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

test("hub refuses an empty shared token before listening", () => {
	let opened: Hub | undefined;
	try {
		expect(() => {
			opened = startHub({ port: 0, hostname: "127.0.0.1", token: "" });
		}).toThrow(/HUB_TOKEN/);
	} finally {
		opened?.stop();
	}
});

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
	target: { url: string } = { url: httpBase },
): Promise<{ agent: FakeAgent; welcome: Record<string, unknown> }> {
	const ws = new WebSocket(`${target.url.replace(/^http/, "ws")}/agent`, { headers: { authorization: "Bearer t" } });
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

/** Bearer-authed call against an explicit hub (the upgrade test uses a second instance). */
function apiOn(hub: { url: string }, path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${hub.url}${path}`, {
		...init,
		headers: { authorization: "Bearer t", ...(init?.headers ?? {}) },
	});
}

/** The session payload off a hub reply — one named boundary cast for the tests. */
async function sessionOf(response: Response): Promise<SessionJson> {
	// Trusted boundary: the hub's JSON contract is under test, not re-validated here.
	const body = (await response.json()) as { session: SessionJson };
	return body.session;
}

/** The machines listing off a hub reply — same trusted boundary. */
async function machinesOf(response: Response): Promise<MachineJson[]> {
	const body = (await response.json()) as { machines: MachineJson[] };
	return body.machines;
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
		const queryToken = await fetch(`${httpBase}/agent?token=t`);
		expect(queryToken.status).toBe(401);
		const wrongToken = await fetch(`${httpBase}/agent`, { headers: { authorization: "Bearer nope" } });
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

	test("restart re-arms an exited session under the same id, resuming its transcript", async () => {
		const { agent } = await connectAgent("m-restart", "restart-machine");
		const session = await startSession("m-restart", "/srv/restart", { name: "rs", profile: "work" });
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "first start frame");
		const links = { full: "wss://r/r1#w", view: "wss://r/r1#v", web: "https://r/#w", webView: "https://r/#v" };
		agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, sessionFile: "/tmp/rs.jsonl", pid: 11, links }));
		await waitForStatus(session.id, "live");
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, reason: "crashed" }));
		await waitForStatus(session.id, "exited");

		const response = await api(`/api/sessions/${session.id}/restart`, { method: "POST" });
		expect(response.status).toBe(202);
		const reissued = await sessionOf(response);
		expect(reissued.id).toBe(session.id);
		expect(reissued.status).toBe("starting");
		expect(reissued.exitReason).toBeUndefined();
		expect(reissued.exitedAt).toBeUndefined();
		expect(reissued.links).toBeUndefined();
		expect(reissued.sessionFile).toBe("/tmp/rs.jsonl");

		const restart = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "restart start frame");
		expect(restart).toMatchObject({
			id: session.id,
			cwd: "/srv/restart",
			name: "rs",
			profile: "work",
			sessionFile: "/tmp/rs.jsonl",
			relayUrl: wsBase,
			webUrl: httpBase,
		});

		// A heartbeat racing the fresh child's spawn must not retire the
		// re-armed record ("no such child") — the restart grace window.
		agent.ws.send(JSON.stringify({ t: "hb", ts: Date.now(), sessions: [] }));
		await yieldLoop();
		expect((await sessionJson(session.id)).status).toBe("starting");

		agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, sessionFile: "/tmp/rs.jsonl", pid: 12, links }));
		expect((await waitForStatus(session.id, "live")).pid).toBe(12);

		// Restarting a still-active session is rejected.
		const conflict = await api(`/api/sessions/${session.id}/restart`, { method: "POST" });
		expect(conflict.status).toBe(409);
		expect((await sessionJson(session.id)).status).toBe("live");

		const missing = await api("/api/sessions/s_0000000000/restart", { method: "POST" });
		expect(missing.status).toBe(404);
	});

	test("restart of a failed start re-runs fresh; an offline machine is 404", async () => {
		const { agent } = await connectAgent("m-retry", "retry-machine");
		const session = await startSession("m-retry", "/nope");
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "first start frame");
		agent.ws.send(JSON.stringify({ t: "session-error", id: session.id, error: "cwd is not an existing directory" }));
		await waitForStatus(session.id, "failed");

		const response = await api(`/api/sessions/${session.id}/restart`, { method: "POST" });
		expect(response.status).toBe(202);
		expect((await sessionOf(response)).status).toBe("starting");
		const retry = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "retry start frame");
		expect(retry).toMatchObject({ id: session.id, cwd: "/nope" });
		expect(retry.sessionFile).toBeUndefined(); // nothing to resume

		// Offline: disconnect the agent; the terminal record stays, restart refuses.
		agent.ws.close();
		await waitForMachine("m-retry", false);
		const offline = await api(`/api/sessions/${session.id}/restart`, { method: "POST" });
		expect(offline.status).toBe(404);
		expect(await offline.json()).toEqual({ error: "machine offline" });
	});

	test("DELETE drops the record and stops a live session first", async () => {
		const { agent } = await connectAgent("m-del", "del-machine");
		const session = await startSession("m-del", "/srv/del");
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		agent.ws.send(
			JSON.stringify({ t: "session-ready", id: session.id, links: { full: "a", view: "b", web: "c", webView: "d" } }),
		);
		await waitForStatus(session.id, "live");

		const deleted = await api(`/api/sessions/${session.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ ok: true });
		expect(await agent.wait((frame) => (frame.t === "stop" ? frame : undefined), "stop frame")).toMatchObject({
			id: session.id,
			reason: "user delete",
		});
		expect((await api(`/api/sessions/${session.id}`)).status).toBe(404);
		const listed = (await (await api("/api/sessions")).json()) as { sessions: SessionJson[] };
		expect(listed.sessions.map((record) => record.id)).not.toContain(session.id);
	});

	test("POST /api/hub/restart invokes the wired restart and 501s when unwired", async () => {
		let restarts = 0;
		hub.core.onRestart = () => {
			restarts += 1;
		};
		const response = await api("/api/hub/restart", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(restarts).toBe(1);
		hub.core.onRestart = null;

		const unavailable = await api("/api/hub/restart", { method: "POST" });
		expect(unavailable.status).toBe(501);
	});

	test("upgrade restart: snapshot restores records, heartbeats reconcile dead ones", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "hub-upgrade-"));
		const file = path.join(dir, "state.json");
		const first = startHub({ port: 0, hostname: "127.0.0.1", token: "t", stateFile: file });
		let sessionId = "";
		try {
			const { agent } = await connectAgent("m-up", "up-machine", {}, first);
			const created = await sessionOf(
				await apiOn(first, "/api/sessions", {
					method: "POST",
					body: JSON.stringify({ machineId: "m-up", cwd: "/srv/up" }),
				}),
			);
			sessionId = created.id;
			expect(created.status).toBe("starting");
			await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
			agent.ws.send(
				JSON.stringify({ t: "session-ready", id: sessionId, links: { full: "a", view: "b", web: "c", webView: "d" } }),
			);
			const deadline = Date.now() + 4_000;
			for (;;) {
				const record = await sessionOf(await apiOn(first, `/api/sessions/${sessionId}`));
				if (record.status === "live") {
					expect(record.links).toEqual({ full: "a", view: "b", web: "c", webView: "d" });
					break;
				}
				if (Date.now() > deadline) throw new Error(`session never went live: ${JSON.stringify(record)}`);
				await yieldLoop();
			}
			// The fake agent dies with the hub: no session-exit frames are sent.
		} finally {
			// Graceful stop flushes first, exactly like the SIGTERM path.
			await first.flushState();
			first.stop();
		}

		const second = startHub({ port: 0, hostname: "127.0.0.1", token: "t", stateFile: file });
		try {
			// Restored before any agent reconnects: `live`, links intact, machine down.
			const restored = await sessionOf(await apiOn(second, `/api/sessions/${sessionId}`));
			expect(restored.status).toBe("live");
			expect(restored.links).toEqual({ full: "a", view: "b", web: "c", webView: "d" });
			const machines = await machinesOf(await apiOn(second, "/api/machines"));
			expect(machines.map((machine) => machine.connected)).toEqual([false]);

			// The daemon reconnects and its first heartbeat no longer reports the
			// child (it died with the old hub) — the restored record must flip.
			const { agent } = await connectAgent("m-up", "up-machine", {}, second);
			agent.ws.send(JSON.stringify({ t: "hb", ts: Date.now(), sessions: [] }));
			const deadline = Date.now() + 4_000;
			for (;;) {
				const record = await sessionOf(await apiOn(second, `/api/sessions/${sessionId}`));
				if (record.status === "exited") {
					expect(record.exitReason).toBe("agent heartbeat: no such child");
					break;
				}
				if (Date.now() > deadline) throw new Error(`record never reconciled: ${JSON.stringify(record)}`);
				await yieldLoop();
			}
		} finally {
			second.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("DELETE on an exited session skips the stop frame; unknown ids are 404", async () => {
		const { agent } = await connectAgent("m-del2", "del2-machine");
		const session = await startSession("m-del2", "/srv/del2");
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "done" }));
		await waitForStatus(session.id, "exited");

		const deleted = await api(`/api/sessions/${session.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(agent.frames.some((frame) => frame.t === "stop")).toBe(false);
		expect((await api(`/api/sessions/${session.id}`)).status).toBe(404);

		const missing = await api("/api/sessions/s_0000000000", { method: "DELETE" });
		expect(missing.status).toBe(404);
	});

	test("session-activity mirrors samples, drops malformed ones, and clears on exit", async () => {
		const { agent } = await connectAgent("m-act", "act-machine");
		const session = await startSession("m-act", "/srv/act");
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		agent.ws.send(
			JSON.stringify({ t: "session-ready", id: session.id, links: { full: "a", view: "b", web: "c", webView: "d" } }),
		);
		await waitForStatus(session.id, "live");

		/** Polls the session record until `match` holds (no fixed delay). */
		const waitFor = async (match: (record: SessionJson) => boolean, what: string): Promise<SessionJson> => {
			const deadline = Date.now() + 4_000;
			for (;;) {
				const response = await api(`/api/sessions/${session.id}`);
				const record = ((await response.json()) as { session: SessionJson }).session;
				if (match(record)) return record;
				if (Date.now() > deadline) throw new Error(`session never ${what}: ${JSON.stringify(record)}`);
				await yieldLoop();
			}
		};

		agent.ws.send(JSON.stringify({ t: "session-activity", id: session.id, working: true, inputRequired: false }));
		const busy = await waitFor((record) => record.activity?.working === true, "report working");
		expect(busy.activity?.inputRequired).toBe(false);

		// A malformed sample must not clobber the last good one…
		agent.ws.send(JSON.stringify({ t: "session-activity", id: session.id, working: "yes", inputRequired: 1 }));
		// …and an unknown session id must be ignored without disturbing this one.
		agent.ws.send(JSON.stringify({ t: "session-activity", id: "s_ignoredxxx", working: true, inputRequired: true }));
		agent.ws.send(JSON.stringify({ t: "session-activity", id: session.id, working: false, inputRequired: true }));
		const awaiting = await waitFor((record) => record.activity?.inputRequired === true, "report input required");
		expect(awaiting.activity?.working).toBe(false);

		// §2 `name`: a sample carrying the SDK session name updates the registry
		// label; a later sample without one leaves the label alone.
		agent.ws.send(
			JSON.stringify({ t: "session-activity", id: session.id, working: false, inputRequired: true, name: "Auth refactor" }),
		);
		const named = await waitFor((record) => record.name === "Auth refactor", "apply activity name");
		expect(named.activity?.inputRequired).toBe(true);
		agent.ws.send(JSON.stringify({ t: "session-activity", id: session.id, working: false, inputRequired: false }));
		const unnamed = await waitFor((record) => record.activity?.working === false, "report working again");
		expect(unnamed.name).toBe("Auth refactor");

		// §2 `handoff`: the bit rides the sample while a handoff document
		// generates, and the next sample without it clears it again.
		agent.ws.send(
			JSON.stringify({ t: "session-activity", id: session.id, working: false, inputRequired: false, handoff: true }),
		);
		const handing = await waitFor((record) => record.activity?.handoff === true, "report handoff");
		expect(handing.activity?.working).toBe(false);
		agent.ws.send(JSON.stringify({ t: "session-activity", id: session.id, working: false, inputRequired: false }));
		const doneHandoff = await waitFor((record) => record.activity?.handoff === undefined, "clear handoff");
		expect(doneHandoff.activity?.working).toBe(false);

		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, reason: "done" }));
		const exited = await waitForStatus(session.id, "exited");
		expect(exited.activity).toBeUndefined();
	});

	test("POST /title dispatches generate-title and mirrors the label", async () => {
		const { agent } = await connectAgent("m-gentitle", "gentitle-machine");
		const session = await startSession("m-gentitle", "/srv/gentitle");
		agent.ws.send(
			JSON.stringify({ t: "session-ready", id: session.id, links: { full: "a", view: "b", web: "c", webView: "d" } }),
		);
		await waitForStatus(session.id, "live");

		const pending = api(`/api/sessions/${session.id}/title`, { method: "POST" });
		const cmd = await agent.wait(
			(frame) => (frame.t === "cmd" && frame.cmd === "generate-title" ? (frame.reqId as string) : undefined),
			"generate-title cmd",
		);
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: cmd, ok: true, data: { name: "Generated title" } }));
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, name: "Generated title" });
		expect((await sessionJson(session.id)).name).toBe("Generated title");

		// An agent-side refusal maps to the cmd plumbing error, and the label stays.
		const refused = api(`/api/sessions/${session.id}/title`, { method: "POST" });
		const retry = await agent.wait(
			(frame) => (frame.t === "cmd" && frame.cmd === "generate-title" ? (frame.reqId as string) : undefined),
			"second generate-title cmd",
		);
		agent.ws.send(
			JSON.stringify({ t: "cmd-result", reqId: retry, ok: false, error: "Could not generate a session title." }),
		);
		const failed = await refused;
		expect(failed.status).toBe(500);
		expect((await failed.json())).toEqual({ error: "Could not generate a session title." });
		expect((await sessionJson(session.id)).name).toBe("Generated title");

		// Not live → dispatch refuses before any cmd round trip.
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, reason: "done" }));
		await waitForStatus(session.id, "exited");
		const dead = await api(`/api/sessions/${session.id}/title`, { method: "POST" });
		expect(dead.status).toBe(409);
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

	test("start.tools is forwarded to the agent and echoed on the record", async () => {
		const { agent } = await connectAgent("m-tools", "tools-machine");
		const tools = ["bash", "read", "edit", "write"];

		const session = await startSession("m-tools", "/srv/pious", { tools });
		expect(session.tools).toEqual(tools);
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect(start).toMatchObject({ id: session.id, tools });
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "done" }));
	});

	test("start.tools absent keeps the field off the frame", async () => {
		const { agent } = await connectAgent("m-tools-def", "tools-default-machine");

		const session = await startSession("m-tools-def", "/srv/default-tools");
		expect(session.tools).toBeUndefined();
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect("tools" in start).toBe(false);
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "done" }));
	});

	test("malformed tools is rejected with 400 before any record exists", async () => {
		await connectAgent("m-tools-bad", "tools-bad-machine");

		for (const bad of [[], ["bash", ""], ["bash", "   "], ["bash", 3], "bash"]) {
			const response = await api("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ machineId: "m-tools-bad", cwd: "/srv/x", tools: bad }),
			});
			expect(response.status).toBe(400);
		}
		// No record survived the rejected starts.
		const listing = (await (await api("/api/sessions")).json()) as { sessions: SessionJson[] };
		expect(listing.sessions.filter((s) => s.machineId === "m-tools-bad")).toEqual([]);
	});

	test("start.tools entries are trimmed and deduped to one canonical form", async () => {
		const { agent } = await connectAgent("m-tools-can", "tools-can-machine");

		const session = await startSession("m-tools-can", "/srv/canonical", {
			tools: [" bash ", "bash", "read"],
		});
		expect(session.tools).toEqual(["bash", "read"]);
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

	test("agent disconnect marks sessions unreachable without falsely reporting completion", async () => {
		const { agent } = await connectAgent("m-drop", "drop-machine");
		const session = await startSession("m-drop", "/srv/dropped");
		await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");

		agent.ws.close();
		expect(await waitForMachine("m-drop", false)).toEqual({
			machineId: "m-drop",
			name: "drop-machine",
			connected: false,
			connectedAt: expect.any(Number),
			sessionCount: 1,
		});
		const unreachable = await sessionJson(session.id);
		expect(unreachable).toMatchObject({ status: "starting", unreachable: true });
		expect(unreachable.exitReason).toBeUndefined();

		// A known but offline machine cannot start sessions.
		const offline = await api("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ machineId: "m-drop", cwd: "/srv/again" }),
		});
		expect(offline.status).toBe(404);
		expect(await offline.json()).toEqual({ error: "machine offline" });
		const refusedStop = await api(`/api/sessions/${session.id}/stop`, { method: "POST" });
		expect(refusedStop.status).toBe(502);
		expect(await refusedStop.json()).toEqual({ error: "agent offline" });
		expect(await sessionJson(session.id)).toMatchObject({ status: "starting", unreachable: true });
	});

	test("a replacement connection reconciles a missing child on its heartbeat", async () => {
		const first = await connectAgent("m-dup", "dup-machine");
		const session = await startSession("m-dup", "/srv/dup");
		await first.agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");

		const second = await connectAgent("m-dup", "dup-machine");
		expect(await waitForMachine("m-dup", true)).toMatchObject({ sessionCount: 1, name: "dup-machine" });
		expect(await sessionJson(session.id)).toMatchObject({ status: "starting", unreachable: true });
		second.agent.ws.send(JSON.stringify({ t: "hb", ts: Date.now(), sessions: [] }));
		const missing = await waitForStatus(session.id, "exited");
		expect(missing.exitReason).toBe("agent heartbeat: no such child");
		expect(second.welcome.relayUrl).toBe(wsBase);

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

	/** Registers the next usage-req wait; answers it with an empty JSON usage-res. */
	async function answerUsageReq(
		agent: FakeAgent,
	): Promise<{ path: unknown; profile: unknown }> {
		const pending = agent.wait((frame) => (frame.t === "usage-req" ? frame : undefined), "usage-req");
		// Attach the reply eagerly so the hub's 15 s relay budget never matters.
		void pending.then((frame) => {
			agent.ws.send(JSON.stringify({
				t: "usage-res",
				reqId: frame.reqId,
				ok: true,
				status: 200,
				contentType: "application/json",
				bodyB64: Buffer.from("{}").toString("base64"),
			}));
		});
		const frame = await pending;
		return { path: frame.path, profile: frame.profile };
	}

	test("usage relay forwards profile on the frame and strips it from the dashboard path", async () => {
		const { agent } = await connectAgent("m-usage-prof", "usage-prof-machine", { version: "0.5.0" });

		const pending = api("/api/machines/m-usage-prof/usage/api/stats?range=24h&profile=fast");
		const seen = await answerUsageReq(agent);
		const response = await pending;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
		expect(seen).toEqual({ path: "/api/stats?range=24h", profile: "fast" });
	});

	test("usage relay treats default and empty profile as the default dashboard", async () => {
		const { agent } = await connectAgent("m-usage-def", "usage-def-machine", { version: "0.5.0" });

		const withDefault = api("/api/machines/m-usage-def/usage/api/stats?range=all&profile=default");
		const first = await answerUsageReq(agent);
		expect((await withDefault).status).toBe(200);
		expect(first).toEqual({ path: "/api/stats?range=all", profile: undefined });

		const omitted = api("/api/machines/m-usage-def/usage/api/stats");
		const second = await answerUsageReq(agent);
		expect((await omitted).status).toBe(200);
		expect(second).toEqual({ path: "/api/stats", profile: undefined });
	});

	test("usage relay rejects invalid profile names with 400", async () => {
		const { agent } = await connectAgent("m-usage-bad", "usage-bad-machine", { version: "0.5.0" });

		const response = await api("/api/machines/m-usage-bad/usage/api/stats?range=24h&profile=../etc");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid profile name" });

		await yieldLoop();
		expect(agent.frames.some((frame) => frame.t === "usage-req")).toBe(false);
	});

	test("usage relay refuses profile requests for agents older than 0.5.0", async () => {
		const { agent } = await connectAgent("m-usage-old", "usage-old-machine", { version: "0.4.0" });

		const refused = await api("/api/machines/m-usage-old/usage/api/stats?range=24h&profile=fast");
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			error: "agent 0.4.0 does not support profile usage relay (needs 0.5.0+)",
		});
		await yieldLoop();
		expect(agent.frames.some((frame) => frame.t === "usage-req")).toBe(false);

		// Without a profile the relay still works against the old agent.
		const pending = api("/api/machines/m-usage-old/usage/api/stats?range=24h");
		const seen = await answerUsageReq(agent);
		expect((await pending).status).toBe(200);
		expect(seen).toEqual({ path: "/api/stats?range=24h", profile: undefined });
	});

	test("MCP management endpoints dispatch mcp-* cmds and map agent errors", async () => {
		const { agent } = await connectAgent("m-mcpapi", "mcpapi-machine");
		const session = await startSession("m-mcpapi", "/srv/mcpapi");
		agent.ws.send(
			JSON.stringify({ t: "session-ready", id: session.id, links: { full: "a", view: "b", web: "c", webView: "d" } }),
		);
		await waitForStatus(session.id, "live");

		const MCP_CMD_BY_PATH: Record<string, string> = {
			"/mcp": "mcp-list",
			"/mcp/add": "mcp-add",
			"/mcp/remove": "mcp-remove",
			"/mcp/enabled": "mcp-set-enabled",
			"/mcp/test": "mcp-test",
		};

		/** One cmd round trip: fire the request, poll frames for the dispatch, answer it. */
		const call = async (
			method: "GET" | "POST",
			path: string,
			opts: { body?: Record<string, unknown>; data?: unknown; fail?: { error: string } } = {},
		): Promise<{ status: number; json: Record<string, unknown>; cmd: Record<string, unknown> }> => {
			const wanted = MCP_CMD_BY_PATH[path]!;
			const seenFrames = agent.frames.length;
			const pending = api(`/api/sessions/${session.id}${path}`, {
				method,
				...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
			});
			const deadline = Date.now() + 4_000;
			let cmd: Record<string, unknown> | undefined;
			for (;;) {
				cmd = agent.frames
					.slice(seenFrames)
					.find((frame) => frame.t === "cmd" && frame.cmd === wanted) as Record<string, unknown> | undefined;
				if (cmd !== undefined || Date.now() > deadline) break;
				await yieldLoop();
			}
			if (cmd === undefined) throw new Error(`timeout waiting for ${wanted}`);
			agent.ws.send(
				JSON.stringify(
					opts.fail === undefined
						? { t: "cmd-result", reqId: cmd.reqId, ok: true, data: opts.data ?? { name: cmd.name } }
						: { t: "cmd-result", reqId: cmd.reqId, ok: false, error: opts.fail.error },
				),
			);
			const response = await pending;
			return { status: response.status, json: (await response.json()) as Record<string, unknown>, cmd };
		};

		// GET listing: the agent's rows ride verbatim.
		const list = await call("GET", "/mcp", { data: { servers: [{ name: "ctx7", scope: "project", enabled: true }] } });
		expect(list.status).toBe(200);
		expect(list.json).toEqual({ ok: true, servers: [{ name: "ctx7", scope: "project", enabled: true }] });

		// POST add: frame carries the validated fields; reply is the agent's.
		const add = await call("POST", "/mcp/add", {
			body: { name: "ctx7", url: "https://mcp.example.dev/api", transport: "sse", token: "shh" },
			data: { name: "ctx7", scope: "user" },
		});
		expect(add.status).toBe(200);
		expect(add.json).toEqual({ ok: true, name: "ctx7", scope: "user" });
		expect(add.cmd).toMatchObject({
			cmd: "mcp-add",
			name: "ctx7",
			url: "https://mcp.example.dev/api",
			transport: "sse",
			token: "shh",
		});

		// add validation: each is refused before any cmd leaves the hub.
		for (const body of [
			{},
			{ name: "" },
			{ name: "x" },
			{ name: "x", url: "https://a.dev", command: "bun" },
			{ name: "x", url: "https://a.dev", scope: "global" },
			{ name: "x", url: "https://a.dev", transport: "ws" },
			{ name: "x", url: "https://a.dev", token: " " },
			{ name: "x", token: "t" },
			{ name: "x", url: "https://a.dev", args: [1] },
		]) {
			const bad = await api(`/api/sessions/${session.id}/mcp/add`, { method: "POST", body: JSON.stringify(body) });
			expect(bad.status).toBe(400);
		}
		await yieldLoop();
		expect(agent.frames.filter((frame) => frame.t === "cmd" && frame.cmd === "mcp-add")).toHaveLength(1);

		// Agent-reported failures map by the writer's message.
		const duplicate = await call("POST", "/mcp/add", {
			body: { name: "ctx7", command: "bun" },
			fail: { error: 'Server "ctx7" already exists in /home/u/.omp/agent/mcp.json' },
		});
		expect(duplicate.status).toBe(409);
		const missing = await call("POST", "/mcp/remove", {
			body: { name: "gone" },
			fail: { error: 'Server "gone" not found in /home/u/.omp/agent/mcp.json' },
		});
		expect(missing.status).toBe(404);
		const untestable = await call("POST", "/mcp/test", {
			body: { name: "ghost" },
			fail: { error: 'server "ghost" not found or disabled (see mcp-list)' },
		});
		expect(untestable.status).toBe(404);

		// enable/disable round trip with the touched-file report.
		const enabled = await call("POST", "/mcp/enabled", {
			body: { name: "ctx7", enabled: false },
			data: { name: "ctx7", enabled: false, where: "project" },
		});
		expect(enabled.status).toBe(200);
		expect(enabled.json).toEqual({ ok: true, name: "ctx7", enabled: false, where: "project" });
		const badEnabled = await api(`/api/sessions/${session.id}/mcp/enabled`, {
			method: "POST",
			body: JSON.stringify({ name: "ctx7", enabled: "yes" }),
		});
		expect(badEnabled.status).toBe(400);

		// test carries the bounded catalog.
		const tested = await call("POST", "/mcp/test", {
			body: { name: "ctx7" },
			data: { name: "ctx7", count: 1, tools: [{ name: "resolve" }] },
		});
		expect(tested.status).toBe(200);
		expect(tested.json).toEqual({ ok: true, name: "ctx7", count: 1, tools: [{ name: "resolve" }] });

		// Not live → every MCP route refuses before dispatch.
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, reason: "done" }));
		await waitForStatus(session.id, "exited");
		expect((await api(`/api/sessions/${session.id}/mcp`)).status).toBe(409);
		expect(
			(await api(`/api/sessions/${session.id}/mcp/add`, { method: "POST", body: JSON.stringify({ name: "x", command: "bun" }) }))
				.status,
		).toBe(409);
	});
});
