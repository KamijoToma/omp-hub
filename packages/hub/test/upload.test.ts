/**
 * File upload route (docs/protocol.md §3 `POST /api/sessions/:id/files` → §2
 * `upload-file`) against a hub started in-process, with a fake agent daemon
 * answering the `upload-file` cmd over a real WebSocket.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { startHub, type Hub } from "../src/server";

interface SessionJson {
	id: string;
	status: string;
}

interface Ctx {
	readonly hub: Hub;
	readonly http: string;
	readonly ws: string;
}

const LINKS = {
	full: "wss://relay.example/r/room#write",
	view: "wss://relay.example/r/room#view",
	web: "https://relay.example/#write",
	webView: "https://relay.example/#view",
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

/** Starts a session on `machineId` and drives it to `live`. */
async function liveSession(ctx: Ctx, agent: FakeAgent, machineId: string): Promise<SessionJson> {
	const created = await api(ctx, "/api/sessions", { method: "POST", body: JSON.stringify({ machineId, cwd: "/srv/upload" }) });
	expect(created.status).toBe(202);
	const session = ((await created.json()) as { session: SessionJson }).session;
	await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
	agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, links: LINKS }));
	const deadline = Date.now() + 4_000;
	for (;;) {
		const record = await (await api(ctx, `/api/sessions/${session.id}`)).json() as { session: SessionJson };
		if (record.session.status === "live") return record.session;
		if (Date.now() > deadline) throw new Error(`session stayed "${record.session.status}"`);
		await yieldLoop();
	}
}

/** Answers the next `upload-file` cmd frame; returns the frame for shape assertions. */
async function answerUpload(agent: FakeAgent, result: Record<string, unknown>): Promise<Record<string, unknown>> {
	const frame = await agent.wait((f) => (f.t === "cmd" && f.cmd === "upload-file" ? f : undefined), "upload-file cmd");
	agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
	return frame;
}

function postFile(ctx: Ctx, id: string, name: string | null, body: string): Promise<Response> {
	const headers: Record<string, string> = { authorization: "Bearer t" };
	if (name !== null) headers["x-filename"] = encodeURIComponent(name);
	return fetch(`${ctx.http}/api/sessions/${encodeURIComponent(id)}/files`, { method: "POST", headers, body });
}

describe("POST /api/sessions/:id/files", () => {
	test("streams the body as upload-file and relays the child's path", async () => {
		const agent = await connectAgent(main, "m-upload", "upload-machine");
		const session = await liveSession(main, agent, "m-upload");

		const response = postFile(main, session.id, "report.pdf", "%PDF-1.4 bytes");
		const frame = await answerUpload(agent, { ok: true, data: { path: "/tmp/omp-hub-upload-abc-report.pdf", bytes: 13 } });
		expect(frame).toMatchObject({
			id: session.id,
			cmd: "upload-file",
			name: "report.pdf",
			dataB64: Buffer.from("%PDF-1.4 bytes").toString("base64"),
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, path: "/tmp/omp-hub-upload-abc-report.pdf", bytes: 13 });
	});

	test("requires the bearer token and an x-filename header", async () => {
		const anon = await fetch(`${main.http}/api/sessions/whatever/files`, { method: "POST", body: "x" });
		expect(anon.status).toBe(401);

		const agent = await connectAgent(main, "m-upload-2", "upload-machine-2");
		const session = await liveSession(main, agent, "m-upload-2");

		const unnamed = await postFile(main, session.id, null, "x");
		expect(unnamed.status).toBe(400);
		expect(await unnamed.json()).toEqual({ error: "x-filename header is required" });

		const blank = await postFile(main, session.id, "   ", "x");
		expect(blank.status).toBe(400);
		expect(await blank.json()).toEqual({ error: "invalid x-filename" });

		const empty = await postFile(main, session.id, "a.bin", "");
		expect(empty.status).toBe(400);
		expect(await empty.json()).toEqual({ error: "empty body" });
	});

	test("a body over the 15 MiB cap fails 413 before any cmd is sent", async () => {
		// Own cluster: the multi-MB body can leave the shared keep-alive socket stale.
		const ctx = startCluster();
		try {
			const agent = await connectAgent(ctx, "m-upload-big", "upload-big-machine");
			const session = await liveSession(ctx, agent, "m-upload-big");

			const oversized = "x".repeat(15 * 1024 * 1024 + 1);
			const response = await fetch(`${ctx.http}/api/sessions/${session.id}/files`, {
				method: "POST",
				headers: { authorization: "Bearer t", "x-filename": "big.bin" },
				body: oversized,
			});
			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ error: "file too large" });
		} finally {
			ctx.hub.stop();
		}
	});

	test("agent-reported upload failures map to client statuses", async () => {
		const agent = await connectAgent(main, "m-upload-4", "upload-machine-4");
		const session = await liveSession(main, agent, "m-upload-4");

		const tooLarge = postFile(main, session.id, "big.bin", "x");
		await answerUpload(agent, { ok: false, error: "file too large" });
		expect((await tooLarge).status).toBe(413);

		const badEncoding = postFile(main, session.id, "bad.bin", "x");
		await answerUpload(agent, { ok: false, error: "invalid upload encoding" });
		expect((await badEncoding).status).toBe(400);
	});

	test("unknown sessions 404 before any cmd is sent", async () => {
		const response = await postFile(main, "no-such-session", "a.bin", "x");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "session not found" });
	});
});
