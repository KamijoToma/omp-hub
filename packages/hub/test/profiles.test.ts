/**
 * Machine-level `list-profiles` channel (docs/protocol.md §2 "Machine commands"
 * + §3 `GET /api/machines/:id/profiles`) against a hub started in-process, with
 * a fake agent daemon over a real WebSocket. Name validation is covered by the
 * `POST /api/sessions` tests in api.test.ts.
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

const PROFILES = ["personal", "work"];

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
let slow: Ctx;

beforeAll(() => {
	main = startCluster();
	slow = startCluster({ cmdTimeoutMs: 50 });
});

afterAll(() => {
	main.hub.stop();
	slow.hub.stop();
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

describe("machine profile listing", () => {
	test("the route needs the bearer token", async () => {
		const anon = await fetch(`${main.http}/api/machines/m-prof/fs`);
		expect(anon.status).toBe(401);
	});

	test("unknown machines answer 404", async () => {
		const response = await api(main, "/api/machines/m-ghost/profiles");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "machine not found" });
	});

	test("forwards list-profiles and returns the agent's profiles", async () => {
		const agent = await connectAgent(main, "m-prof", "prof-machine");

		const response = api(main, "/api/machines/m-prof/profiles");
		const frame = await agent.wait((f) => (f.t === "cmd" ? f : undefined), "list-profiles frame");
		expect(frame).toEqual({
			t: "cmd",
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "list-profiles",
		});
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ok: true, data: { profiles: PROFILES } }));

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, profiles: PROFILES });
	});

	test("agent-reported failures surface with the agent's error", async () => {
		const agent = await connectAgent(main, "m-prof-bad", "prof-bad-machine");

		const response = api(main, "/api/machines/m-prof-bad/profiles");
		const frame = await agent.wait((f) => (f.t === "cmd" ? f : undefined), "list-profiles frame");
		agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ok: false, error: "permission denied" }));

		const settled = await response;
		expect(settled.status).toBe(400);
		expect(await settled.json()).toEqual({ error: "permission denied" });
	});

	test("a machine that dropped offline answers 502", async () => {
		const agent = await connectAgent(main, "m-prof-off", "prof-offline-machine");
		agent.ws.close(1000, "test done");

		const deadline = Date.now() + 4_000;
		for (;;) {
			const machines = (await (await api(main, "/api/machines")).json()) as {
				machines: Array<{ machineId: string; connected: boolean }>;
			};
			if (machines.machines.find((m) => m.machineId === "m-prof-off")?.connected === false) break;
			if (Date.now() > deadline) throw new Error(`machine stayed online; machines: ${JSON.stringify(machines)}`);
			await yieldLoop();
		}

		const response = await api(main, "/api/machines/m-prof-off/profiles");
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "agent offline" });
	});

	test("a silent agent answers 504 once the cmd budget elapses", async () => {
		await connectAgent(slow, "m-prof-slow", "prof-slow-machine");

		const response = await api(slow, "/api/machines/m-prof-slow/profiles");
		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({ error: "cmd timeout" });
	});
});
