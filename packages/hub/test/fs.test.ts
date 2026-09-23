/**
 * Machine-level `list-dir` channel (docs/protocol.md §2 "Machine commands" +
 * §3 `GET /api/machines/:id/fs`) against a hub started in-process, with a fake
 * agent daemon over a real WebSocket.
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
	path: "/home/dev",
	parent: "/home",
	entries: [
		{ name: "omp-hub", path: "/home/dev/omp-hub" },
		{ name: "oh-my-pi", path: "/home/dev/oh-my-pi" },
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
	const ws = new WebSocket(`${ctx.ws}/agent`, { headers: { authorization: "Bearer t" } });
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

/** Answers the next `list-dir` frame with `result`; returns the frame for shape assertions. */
async function answerListDir(agent: FakeAgent, result: Record<string, unknown>): Promise<Record<string, unknown>> {
	const frame = await agent.wait((f) => (f.t === "cmd" ? f : undefined), "list-dir frame");
	expect(frame.cmd).toBe("list-dir");
	agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
	return frame;
}

describe("machine directory listing", () => {
	test("the route needs the bearer token", async () => {
		const anon = await fetch(`${main.http}/api/machines/m-fs/fs`);
		expect(anon.status).toBe(401);
		expect(await anon.json()).toEqual({ error: "unauthorized" });
	});

	test("unknown machines answer 404", async () => {
		const response = await api(main, "/api/machines/m-ghost/fs");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "machine not found" });
	});

	test("forwards list-dir without a path and returns the agent's listing", async () => {
		const agent = await connectAgent(main, "m-fs", "fs-machine");

		const response = api(main, "/api/machines/m-fs/fs");
		const frame = await answerListDir(agent, { ok: true, data: LISTING });
		// Machine-level: no session id, and no path ⇒ the agent lists its home.
		expect(frame).toEqual({
			t: "cmd",
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "list-dir",
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, listing: LISTING });
	});

	test("passes the requested path through to the agent", async () => {
		const agent = await connectAgent(main, "m-fs-path", "fs-path-machine");

		const response = api(main, `/api/machines/m-fs-path/fs?path=${encodeURIComponent("/srv/dev projects")}`);
		const frame = await answerListDir(agent, { ok: true, data: { ...LISTING, path: "/srv/dev projects" } });
		expect(frame).toEqual({
			t: "cmd",
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "list-dir",
			path: "/srv/dev projects",
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, listing: { ...LISTING, path: "/srv/dev projects" } });
	});

	test("agent-reported path failures surface as 400 with the agent's error", async () => {
		const agent = await connectAgent(main, "m-fs-bad", "fs-bad-machine");

		const badPath = api(main, "/api/machines/m-fs-bad/fs?path=/etc/hostname");
		await answerListDir(agent, { ok: false, error: "no such directory" });
		const settled = await badPath;
		expect(settled.status).toBe(400);
		expect(await settled.json()).toEqual({ error: "no such directory" });

		// Agent failures outside the known set stay server errors.
		const serverError = api(main, "/api/machines/m-fs-bad/fs");
		await answerListDir(agent, { ok: false, error: "readdir exploded" });
		const failed = await serverError;
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "readdir exploded" });
	});

	test("a machine that dropped offline answers 502", async () => {
		const agent = await connectAgent(main, "m-fs-off", "fs-offline-machine");
		agent.ws.close(1000, "test done");

		// The hub flips the machine offline from the socket close event.
		const deadline = Date.now() + 4_000;
		for (;;) {
			const machines = (await (await api(main, "/api/machines")).json()) as {
				machines: Array<{ machineId: string; connected: boolean }>;
			};
			if (machines.machines.find((m) => m.machineId === "m-fs-off")?.connected === false) break;
			if (Date.now() > deadline) throw new Error(`machine stayed online; machines: ${JSON.stringify(machines)}`);
			await yieldLoop();
		}

		const response = await api(main, "/api/machines/m-fs-off/fs");
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "agent offline" });
	});
});

describe("machine directory listing timeout", () => {
	let slow: Ctx;

	beforeAll(() => {
		slow = startCluster({ cmdTimeoutMs: 50 });
	});

	afterAll(() => {
		slow.hub.stop();
	});

	test("a silent agent answers 504 once the cmd budget elapses", async () => {
		await connectAgent(slow, "m-fs-slow", "fs-slow-machine");

		const response = await api(slow, "/api/machines/m-fs-slow/fs");
		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({ error: "cmd timeout" });
	});
});
