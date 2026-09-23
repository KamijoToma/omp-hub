/**
 * Machine-level `list-sessions` channel (docs/protocol.md §2 "Machine commands"
 * + §3 `GET /api/machines/:id/sessions`) against a hub started in-process, with
 * a fake agent daemon over a real WebSocket. Mirrors fs.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { startHub, type Hub } from "../src/server";

/** Hub instance plus the origins its tests talk to. */
interface Ctx {
	readonly hub: Hub;
	readonly http: string;
	readonly ws: string;
}

const LISTING = {
	sessions: [
		{
			path: "/home/dev/project/.omp/sessions/20260627_a.jsonl",
			id: "resume01aa",
			cwd: "/home/dev/project",
			title: "Fix the login bug",
			created: "2026-06-27T00:00:00.000Z",
			modified: "2026-06-27T12:00:00.000Z",
			messageCount: 2,
			assistantTurns: 1,
			status: "complete",
			firstMessage: "first prompt",
		},
	],
	truncated: false,
};

/** Yields the event loop so pending socket I/O can be processed (no fixed delay). */
const yieldLoop = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

function startCluster(overrides: Partial<Config> = {}): Ctx {
	const hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "", ...overrides });
	return { hub, http: hub.url, ws: hub.url.replace(/^http/, "ws") };
}

let main: Ctx;

beforeAll(() => {
	main = startCluster();
});

afterAll(() => {
	main.hub.stop();
});

function api(ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${ctx.http}${path}`, {
		headers: { authorization: "Bearer t" },
		...init,
	});
}

interface FakeAgent {
	readonly ws: WebSocket;
	/** Waits for the next frame matching the predicate, skipping unmatched earlier frames. */
	wait<T>(match: (frame: Record<string, unknown>) => T | undefined, what: string): Promise<T>;
}

async function connectAgent(ctx: Ctx, machineId: string, name: string): Promise<FakeAgent> {
	const ws = new WebSocket(`${ctx.ws}/agent?token=t`);
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

	ws.send(JSON.stringify({ t: "hello", name, machineId, version: "test" }));
	await wait((frame) => (frame.t === "welcome" ? frame : undefined), "welcome");
	return { ws, wait };
}

/** Answers the next `list-sessions` frame with `result`; returns the frame for shape assertions. */
async function answerListSessions(
	agent: FakeAgent,
	result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const frame = await agent.wait((f) => (f.t === "cmd" ? f : undefined), "list-sessions frame");
	expect(frame.cmd).toBe("list-sessions");
	agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
	return frame;
}

describe("machine session history", () => {
	test("the route needs the bearer token", async () => {
		const anon = await fetch(`${main.http}/api/machines/m-hist/sessions`);
		expect(anon.status).toBe(401);
		expect(await anon.json()).toEqual({ error: "unauthorized" });
	});

	test("unknown machines answer 404", async () => {
		const response = await api(main, "/api/machines/m-ghost/sessions");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "machine not found" });
	});

	test("forwards list-sessions without a cwd and returns the agent's listing", async () => {
		const agent = await connectAgent(main, "m-hist", "hist-machine");

		const response = api(main, "/api/machines/m-hist/sessions");
		const frame = await answerListSessions(agent, { ok: true, data: LISTING });
		// Machine-level: no session id, and no cwd ⇒ the agent lists every project.
		expect(frame).toEqual({
			t: "cmd",
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "list-sessions",
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, listing: LISTING });
	});

	test("passes the requested cwd scope through to the agent", async () => {
		const agent = await connectAgent(main, "m-hist-scope", "hist-scope-machine");

		const response = api(main, `/api/machines/m-hist-scope/sessions?cwd=${encodeURIComponent("/srv/dev projects")}`);
		const frame = await answerListSessions(agent, { ok: true, data: { ...LISTING, truncated: true } });
		expect(frame).toEqual({
			t: "cmd",
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "list-sessions",
			cwd: "/srv/dev projects",
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, listing: { ...LISTING, truncated: true } });
	});

	test("agent-reported failures surface with the mapped status", async () => {
		const agent = await connectAgent(main, "m-hist-bad", "hist-bad-machine");

		const failed = api(main, "/api/machines/m-hist-bad/sessions");
		await answerListSessions(agent, { ok: false, error: "readdir exploded" });
		const settled = await failed;
		expect(settled.status).toBe(500);
		expect(await settled.json()).toEqual({ error: "readdir exploded" });
	});

	test("a machine that dropped offline answers 502", async () => {
		const agent = await connectAgent(main, "m-hist-off", "hist-offline-machine");
		agent.ws.close(1000, "test done");

		// The hub flips the machine offline from the socket close event.
		const deadline = Date.now() + 4_000;
		for (;;) {
			const machines = (await (await api(main, "/api/machines")).json()) as {
				machines: Array<{ machineId: string; connected: boolean }>;
			};
			if (machines.machines.find((m) => m.machineId === "m-hist-off")?.connected === false) break;
			if (Date.now() > deadline) throw new Error(`machine stayed online; machines: ${JSON.stringify(machines)}`);
			await yieldLoop();
		}

		const response = await api(main, "/api/machines/m-hist-off/sessions");
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "agent offline" });
	});
});
