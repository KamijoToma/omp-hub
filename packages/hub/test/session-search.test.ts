/**
 * Machine-level message search (docs/protocol.md §2 `search-sessions` +
 * §3 `POST /api/machines/:id/sessions/search`) against a hub started
 * in-process, with a fake agent daemon over a real WebSocket.
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
		headers: { authorization: "Bearer t", "content-type": "application/json" },
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

/** Answers the next `search-sessions` frame with `result`; returns the frame for shape assertions. */
async function answerSearch(agent: FakeAgent, result: Record<string, unknown>): Promise<Record<string, unknown>> {
	const frame = await agent.wait((f) => (f.t === "cmd" && f.cmd === "search-sessions" ? f : undefined), "search-sessions frame");
	agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
	return frame;
}

/** Starts a registry session on `machineId` and flips it live with `sessionFile`. */
async function startLiveSession(
	agent: FakeAgent,
	machineId: string,
	sessionFile: string,
): Promise<string> {
	const created = await api(main, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ machineId, cwd: "/srv/projects/demo" }),
	});
	expect(created.status).toBe(202);
	const session = ((await created.json()) as { session: { id: string } }).session;
	await agent.wait((frame) => (frame.t === "start" && frame.id === session.id ? frame : undefined), "start frame");
	agent.ws.send(
		JSON.stringify({
			t: "session-ready",
			id: session.id,
			sessionFile,
			pid: 4242,
			links: { full: "a", view: "b", web: "c", webView: "d" },
		}),
	);
	const deadline = Date.now() + 4_000;
	for (;;) {
		const record = await api(main, `/api/sessions/${session.id}`);
		const body = (await record.json()) as { session: { status: string; sessionFile?: string } };
		if (body.session.status === "live") break;
		if (Date.now() > deadline) throw new Error(`session ${session.id} never went live`);
		await yieldLoop();
	}
	return session.id;
}

describe("machine session message search", () => {
	test("search is bearer-gated like every other API route", async () => {
		const anon = await fetch(`${main.http}/api/machines/m-search/sessions/search`, {
			method: "POST",
			body: JSON.stringify({ query: "x" }),
		});
		expect(anon.status).toBe(401);
	});

	test("unknown machine and offline agent map to 404/502 before any cmd", async () => {
		const ghost = await api(main, "/api/machines/m-ghost/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "x" }),
		});
		expect(ghost.status).toBe(404);

		// A known machine whose socket dropped: listed but not connected → 502.
		const gone = await connectAgent(main, "m-search", "searcher");
		gone.ws.close();
		await yieldLoop();
		const offline = await api(main, "/api/machines/m-search/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "x" }),
		});
		expect(offline.status).toBe(502);
	});

	test("caller-input failures answer 400 without a cmd round trip", async () => {
		// Machine checks come first, so validation needs a connected machine.
		await connectAgent(main, "m-input", "input-machine");
		const blank: unknown[] = [undefined, "", "   ", "x".repeat(257)];
		for (const query of blank) {
			const response = await api(main, "/api/machines/m-input/sessions/search", {
				method: "POST",
				body: JSON.stringify({ query }),
			});
			expect(response.status).toBe(400);
		}
		const badPaths = await api(main, "/api/machines/m-input/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "x", paths: [42] }),
		});
		expect(badPaths.status).toBe(400);
		const tooMany = await api(main, "/api/machines/m-input/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "x", paths: Array.from({ length: 201 }, (_, i) => `/tmp/${i}.jsonl`) }),
		});
		expect(tooMany.status).toBe(400);
		const noBody = await api(main, "/api/machines/m-input/sessions/search", { method: "POST", body: "not json" });
		expect(noBody.status).toBe(400);
	});

	test("forwards the trimmed needle and deduplicated paths, relays only well-formed hits", async () => {
		const agent = await connectAgent(main, "m-forward", "forward-machine");
		const pending = api(main, "/api/machines/m-forward/sessions/search", {
			method: "POST",
			body: JSON.stringify({
				query: "  needle ",
				paths: ["/store/a.jsonl", "/store/a.jsonl", "/store/b.jsonl"],
			}),
		});
		const frame = await answerSearch(agent, {
			ok: true,
			data: {
				results: [
					{ path: "/store/b.jsonl", count: 2, snippet: "the needle" },
					{ malformed: true },
				],
			},
		});
		expect(frame.query).toBe("needle");
		expect(frame.paths).toEqual(["/store/a.jsonl", "/store/b.jsonl"]);
		expect(frame.id).toBeUndefined();

		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			matches: [{ path: "/store/b.jsonl", count: 2, snippet: "the needle" }],
		});
	});

	test("without paths, the machine's registry sessions are searched", async () => {
		const agent = await connectAgent(main, "m-registry", "registry-machine");
		await startLiveSession(agent, "m-registry", "/store/live.jsonl");

		const pending = api(main, "/api/machines/m-registry/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "needle" }),
		});
		const frame = await answerSearch(agent, { ok: true, data: { results: [] } });
		expect(frame.paths).toEqual(["/store/live.jsonl"]);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, matches: [] });
	});

	test("agent-reported failures map through the cmd error table", async () => {
		const agent = await connectAgent(main, "m-failure", "failure-machine");
		await startLiveSession(agent, "m-failure", "/store/live.jsonl");

		const guarded = api(main, "/api/machines/m-failure/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "needle" }),
		});
		await answerSearch(agent, { ok: false, error: "too many paths" });
		expect((await guarded).status).toBe(400);

		const timedOut = api(main, "/api/machines/m-failure/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "needle" }),
		});
		await answerSearch(agent, { ok: false, error: "cmd timeout" });
		expect((await timedOut).status).toBe(504);

		const malformed = api(main, "/api/machines/m-failure/sessions/search", {
			method: "POST",
			body: JSON.stringify({ query: "needle" }),
		});
		await answerSearch(agent, { ok: true, data: {} });
		const reply = await malformed;
		expect(reply.status).toBe(200);
		expect(await reply.json()).toEqual({ ok: true, matches: [] });
	});
});
