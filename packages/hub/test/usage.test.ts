/**
 * Machine-level usage relay (docs/protocol.md §2 `usage-req`/`usage-res` +
 * §3 `/api/machines/:id/usage/*`) against a hub started in-process, with a
 * fake agent daemon over a real WebSocket. Needs no session: the relay is
 * machine-level.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { startHub, type Hub } from "../src/server";

/** `DashboardStats`-ish payload the fake dashboard answers with. */
const STATS = {
	overall: { totalRequests: 12, totalCost: 1.5 },
	byModel: [],
	timeSeries: [],
};

/** Yields the event loop so pending socket I/O can be processed (no fixed delay). */
const yieldLoop = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

interface Ctx {
	hub: Hub;
	http: string;
	ws: string;
}

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

function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${main.http}${path}`, {
		headers: { authorization: "Bearer t" },
		...init,
	});
}

interface FakeAgent {
	readonly ws: WebSocket;
	/** Waits for the next frame matching the predicate, skipping unmatched earlier frames. */
	wait<T>(match: (frame: Record<string, unknown>) => T | undefined, what: string): Promise<T>;
	close(): void;
}

async function connectAgent(machineId: string, name: string): Promise<FakeAgent> {
	const ws = new WebSocket(`${main.ws}/agent?token=t`);
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
	return { ws, wait, close: () => ws.close() };
}

/** Polls the machine list until the machine's `connected` flag reaches `connected`. */
async function waitForConnection(machineId: string, connected: boolean): Promise<void> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const machines = ((await (await api("/api/machines")).json()) as { machines: Array<{ machineId: string; connected: boolean }> }).machines;
		const record = machines.find((machine) => machine.machineId === machineId);
		if (record?.connected === connected) return;
		if (record === undefined && !connected) return; // pruned/disconnected entry is fine too
		if (Date.now() > deadline) throw new Error(`machine ${machineId} never became connected=${connected}`);
		await yieldLoop();
	}
}

/** Sends the relayed GET and answers it from the fake agent; returns both sides. */
async function relayGet(agent: FakeAgent, path: string, reply: Record<string, unknown>): Promise<{ response: Response; frame: Record<string, unknown> }> {
	const responsePromise = api(path);
	const frame = await agent.wait((f) => (f.t === "usage-req" ? f : undefined), "usage-req frame");
	agent.ws.send(JSON.stringify({ t: "usage-res", reqId: frame.reqId, ...reply }));
	return { response: await responsePromise, frame };
}

describe("usage relay", () => {
	test("requires the bearer token", async () => {
		const response = await fetch(`${main.http}/api/machines/m-x/usage/api/stats`);
		expect(response.status).toBe(401);
	});

	test("404 for an unknown machine", async () => {
		const response = await api("/api/machines/m-nope/usage/api/stats");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "machine not found" });
	});

	test("relays a GET to the machine's dashboard and replays the reply", async () => {
		const agent = await connectAgent("m-usage", "usage-machine");

		const { response, frame } = await relayGet(agent, "/api/machines/m-usage/usage/api/stats?range=24h", {
			ok: true,
			status: 200,
			contentType: "application/json",
			bodyB64: Buffer.from(JSON.stringify(STATS)).toString("base64"),
		});

		expect(frame).toMatchObject({ t: "usage-req", method: "GET", path: "/api/stats?range=24h" });
		expect(frame.reqId).toMatch(/^c_[0-9a-z]{10}$/);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual(STATS);
		agent.close();
	});

	test("relays a POST body", async () => {
		const agent = await connectAgent("m-post", "post-machine");
		const bodyB64 = Buffer.from(JSON.stringify({ forced: true })).toString("base64");

		const responsePromise = api("/api/machines/m-post/usage/api/sync", { method: "POST", body: JSON.stringify({ forced: true }) });
		const frame = await agent.wait((f) => (f.t === "usage-req" ? f : undefined), "usage-req frame");
		agent.ws.send(JSON.stringify({ t: "usage-res", reqId: frame.reqId, ok: true, status: 200, contentType: "application/json", bodyB64: Buffer.from(JSON.stringify({ processed: 1 })).toString("base64") }));

		expect(frame).toMatchObject({ method: "POST", path: "/api/sync" });
		expect(Buffer.from(frame.bodyB64 as string, "base64").toString()).toBe(JSON.stringify({ forced: true }));
		expect((await responsePromise).status).toBe(200);
		agent.close();
	});

	test("replays the dashboard's own error status", async () => {
		const agent = await connectAgent("m-404", "notfound-machine");

		const { response } = await relayGet(agent, "/api/machines/m-404/usage/api/none", {
			ok: true,
			status: 404,
			bodyB64: Buffer.from("nope").toString("base64"),
		});

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("nope");
		agent.close();
	});

	test("surfaces an agent-reported failure as 502", async () => {
		const agent = await connectAgent("m-fail", "failing-machine");

		const { response } = await relayGet(agent, "/api/machines/m-fail/usage/api/stats", {
			ok: false,
			error: "stats dashboard unavailable: no sibling checkout",
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "stats dashboard unavailable: no sibling checkout" });
		agent.close();
	});

	test("rejects methods outside GET/HEAD/POST", async () => {
		const agent = await connectAgent("m-405", "method-machine");
		const response = await api("/api/machines/m-405/usage/api/stats", { method: "DELETE" });
		expect(response.status).toBe(405);
		agent.close();
	});

	test("502 once the machine disconnects", async () => {
		const agent = await connectAgent("m-off", "offline-machine");
		agent.close();
		await waitForConnection("m-off", false);

		const response = await api("/api/machines/m-off/usage/api/stats");
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "machine offline" });
	});

	test("504 when the agent stays silent", async () => {
		const hub = startCluster({ cmdTimeoutMs: 40 }).hub;
		try {
			const http = hub.url;
			const ws = hub.url.replace(/^http/, "ws");
			const socket = new WebSocket(`${ws}/agent?token=t`);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
			});
			socket.send(JSON.stringify({ t: "hello", name: "slow", machineId: "m-slow", version: "test" }));

			const response = await fetch(`${http}/api/machines/m-slow/usage/api/stats`, {
				headers: { authorization: "Bearer t" },
			});
			expect(response.status).toBe(504);
			expect(await response.json()).toEqual({ error: "usage timeout" });
			socket.close();
		} finally {
			hub.stop();
		}
	});
});
