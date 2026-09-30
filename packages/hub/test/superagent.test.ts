/**
 * Superagent surface (docs/protocol.md 0.8.0): `superagent` session start flag,
 * the `prompt` session command over `POST /api/sessions/:id/prompt`, and the
 * `/api/notices` board — against a hub started in-process with a fake agent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { startHub, type Hub } from "../src/server";

interface SessionJson {
	id: string;
	status: string;
	superagent?: true;
	searchMode?: "fleet" | "sql";
}

/** Hub instance plus the origins its tests talk to. */
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

async function connectAgent(ctx: Ctx, machineId: string, name: string, version = "0.12.0"): Promise<FakeAgent> {
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

	ws.send(JSON.stringify({ t: "hello", name, machineId, version }));
	await wait((frame) => (frame.t === "welcome" ? frame : undefined), "welcome");
	return { ws, wait };
}

async function startSession(ctx: Ctx, machineId: string, body: Record<string, unknown>): Promise<SessionJson> {
	const created = await api(ctx, "/api/sessions", { method: "POST", body: JSON.stringify({ machineId, cwd: "/srv/sa", ...body }) });
	expect(created.status).toBe(202);
	return ((await created.json()) as { session: SessionJson }).session;
}

/** Starts a session on `machineId` and drives it to `live`. */
async function liveSession(ctx: Ctx, agent: FakeAgent, machineId: string, body: Record<string, unknown> = {}): Promise<SessionJson> {
	const session = await startSession(ctx, machineId, body);
	await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
	agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, links: LINKS }));
	const deadline = Date.now() + 4_000;
	for (;;) {
		const current = ((await (await api(ctx, `/api/sessions/${session.id}`)).json()) as { session: SessionJson }).session;
		if (current.status === "live") return current;
		if (Date.now() > deadline) throw new Error(`session stayed "${current.status}"`);
		await yieldLoop();
	}
}

/** Answers the next `cmd` frame with `result`; returns the frame for shape assertions. */
async function answerCmd(agent: FakeAgent, cmd: string, result: Record<string, unknown>): Promise<Record<string, unknown>> {
	const frame = await agent.wait((f) => (f.t === "cmd" ? f : undefined), `${cmd} frame`);
	expect(frame.cmd).toBe(cmd);
	agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
	return frame;
}

describe("superagent sessions", () => {
	test("a scoped superagent starts only on a namespace-capable machine", async () => {
		const agent = await connectAgent(main, "m-sa", "sa-machine");
		const created = await api(main, "/api/namespaces", { method: "POST", body: JSON.stringify({ name: "operator-session" }) });
		const data = await created.json();
		if (!data || typeof data !== "object" || !("namespace" in data) ||
			!data.namespace || typeof data.namespace !== "object" || !("id" in data.namespace) || typeof data.namespace.id !== "string") {
			throw new Error("namespace creation did not return an id");
		}
		const namespaceId = data.namespace.id;
		const session = await startSession(main, "m-sa", { superagent: true, namespaceId });
		const frame = await agent.wait((f) => (f.t === "start" ? f : undefined), "start frame");
		expect(frame.superagent).toBe(true);
		agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, links: LINKS }));

		const detail = await api(main, `/api/sessions/${session.id}`);
		const record = ((await detail.json()) as { session: SessionJson }).session;
		expect(record.searchMode).toBe("fleet");
		expect(record).toMatchObject({ superagent: true, namespaceId });
	});

	test("a plain start carries no superagent field", async () => {
		const agent = await connectAgent(main, "m-plain", "plain-machine");
		const session = await startSession(main, "m-plain", {});
		const frame = await agent.wait((f) => (f.t === "start" ? f : undefined), "start frame");
		expect(frame).not.toHaveProperty("superagent");
		agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, links: LINKS }));
	});

	test("superagent must be a boolean", async () => {
		const agent = await connectAgent(main, "m-bad", "bad-machine");
		const created = await api(main, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ machineId: "m-bad", cwd: "/srv/sa", superagent: "yes" }),
		});
		expect(created.status).toBe(400);
		expect(await created.json()).toEqual({ error: "superagent must be a boolean" });
	});

	test("SQL transcript mode is opt-in, version-gated, and retained on restart", async () => {
		const older = await connectAgent(main, "m-sql-old", "sql-old", "0.14.0");
		const modern = await connectAgent(main, "m-sql-ready", "sql-ready", "0.15.0");
		const created = await api(main, "/api/namespaces", {
			method: "POST", body: JSON.stringify({ name: "sql-operator-mode" }),
		});
		expect(created.status).toBe(201);
		const data = (await created.json()) as { namespace: { id: string } };
		const namespaceId = data.namespace.id;
		const base = { cwd: "/srv/sa", namespaceId, searchMode: "sql" };
		const plain = await api(main, "/api/sessions", {
			method: "POST", body: JSON.stringify({ machineId: "m-sql-ready", ...base }),
		});
		expect(plain.status).toBe(400);
		expect(await plain.json()).toEqual({ error: "searchMode requires superagent" });
		const unsupported = await api(main, "/api/sessions", {
			method: "POST", body: JSON.stringify({ machineId: "m-sql-old", ...base, superagent: true }),
		});
		expect(unsupported.status).toBe(409);
		expect(await unsupported.json()).toEqual({ error: "machine daemon must be upgraded for SQL transcript search" });
		const started = await api(main, "/api/sessions", {
			method: "POST", body: JSON.stringify({ machineId: "m-sql-ready", ...base, superagent: true }),
		});
		expect(started.status).toBe(202);
		const record = (await started.json()) as { session: SessionJson & { searchMode?: string } };
		expect(record.session.searchMode).toBe("sql");
		const frame = await modern.wait(f => f.t === "start" ? f : undefined, "SQL superagent start");
		expect(frame.searchMode).toBe("sql");
		modern.ws.send(JSON.stringify({ t: "session-ready", id: record.session.id, links: LINKS }));
		modern.ws.send(JSON.stringify({ t: "session-exit", id: record.session.id, code: 0, reason: "done" }));
		const deadline = Date.now() + 4_000;
		for (;;) {
			const latest = await api(main, `/api/sessions/${record.session.id}`);
			const body = (await latest.json()) as { session: { status: string; searchMode?: string } };
			if (body.session.status === "exited") {
				expect(body.session.searchMode).toBe("sql");
				break;
			}
			if (Date.now() > deadline) throw new Error("SQL operator did not exit");
			await yieldLoop();
		}
		const restart = await api(main, `/api/sessions/${record.session.id}/restart`, { method: "POST" });
		expect(restart.status).toBe(202);
		const replay = await modern.wait(f => f.t === "start" && f.id === record.session.id ? f : undefined, "SQL operator restart");
		expect(replay.searchMode).toBe("sql");
		older.ws.close();
		modern.ws.close();
	});

	test("rejects unscoped operators and 0.11.0 daemons before dispatch", async () => {
		const old = await connectAgent(main, "m-sa-old", "old-machine", "0.11.0");
		const noNamespace = await api(main, "/api/sessions", { method: "POST",
			body: JSON.stringify({ machineId: "m-sa-old", cwd: "/srv/sa", superagent: true }) });
		expect(noNamespace.status).toBe(400);
		const ns = await api(main, "/api/namespaces", { method: "POST", body: JSON.stringify({ name: "legacy-refusal" }) });
		const data = await ns.json();
		if (!data || typeof data !== "object" || !("namespace" in data) ||
			!data.namespace || typeof data.namespace !== "object" || !("id" in data.namespace) || typeof data.namespace.id !== "string") {
			throw new Error("namespace creation did not return an id");
		}
		const refused = await api(main, "/api/sessions", { method: "POST",
			body: JSON.stringify({ machineId: "m-sa-old", cwd: "/srv/sa", superagent: true, namespaceId: data.namespace.id }) });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "machine daemon must be upgraded for namespace-scoped superagents" });
		old.ws.close();
	});
});

describe("POST /api/sessions/:id/prompt", () => {
	test("delivers text via the prompt cmd and relays accepted", async () => {
		const agent = await connectAgent(main, "m-prompt", "prompt-machine");
		const session = await liveSession(main, agent, "m-prompt");

		const response = api(main, `/api/sessions/${session.id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "check the fleet" }),
		});
		const frame = await answerCmd(agent, "prompt", { ok: true, data: { accepted: true } });
		expect(frame).toMatchObject({ id: session.id, cmd: "prompt", text: "check the fleet" });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, accepted: true });
	});

	test("blank text is a caller bug, not a dispatch", async () => {
		const agent = await connectAgent(main, "m-blank", "blank-machine");
		const session = await liveSession(main, agent, "m-blank");
		for (const body of [{}, { text: "" }, { text: "   " }]) {
			const res = await api(main, `/api/sessions/${session.id}/prompt`, { method: "POST", body: JSON.stringify(body) });
			expect(res.status).toBe(400);
		}
	});

	test("unknown session is 404; a session that never went live is 409", async () => {
		const missing = await api(main, "/api/sessions/s_nope/prompt", {
			method: "POST",
			body: JSON.stringify({ text: "hi" }),
		});
		expect(missing.status).toBe(404);

		const agent = await connectAgent(main, "m-starting", "starting-machine");
		await startSession(main, "m-starting", {});
		await agent.wait((f) => (f.t === "start" ? f : undefined), "start frame");
		const res = await api(main, "/api/sessions");
		const starting = ((await res.json()) as { sessions: SessionJson[] }).sessions.find((s) => s.id !== undefined);
		const notLive = await api(main, `/api/sessions/${starting!.id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "hi" }),
		});
		expect(notLive.status).toBe(409);
	});
});

describe("notices", () => {
	test("valid post defaults to info urgency and echoes the notice", async () => {
		const res = await api(main, "/api/notices", { method: "POST", body: JSON.stringify({ message: "deploy done" }) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; notice: { id: string; message: string; urgency: string; createdAt: number } };
		expect(body.ok).toBe(true);
		expect(body.notice.message).toBe("deploy done");
		expect(body.notice.urgency).toBe("info");
		expect(body.notice.id).toMatch(/^n_[0-9a-z]{10}$/);
		expect(typeof body.notice.createdAt).toBe("number");
	});

	test("sessionId is carried when given", async () => {
		const res = await api(main, "/api/notices", {
			method: "POST",
			body: JSON.stringify({ message: "needs input", urgency: "urgent", sessionId: "s_abc" }),
		});
		const body = (await res.json()) as { notice: { urgency: string; sessionId?: string } };
		expect(body.notice.urgency).toBe("urgent");
		expect(body.notice.sessionId).toBe("s_abc");
	});

	test("invalid payloads are rejected with 400", async () => {
		for (const body of [
			{},
			{ message: "" },
			{ message: "   " },
			{ message: "x".repeat(2001) },
			{ message: "ok", urgency: "loud" },
		]) {
			const res = await api(main, "/api/notices", { method: "POST", body: JSON.stringify(body) });
			expect(res.status).toBe(400);
		}
	});

	test("listing is newest first and capped at 50", async () => {
		for (let i = 0; i < 55; i++) {
			const res = await api(main, "/api/notices", { method: "POST", body: JSON.stringify({ message: `n${i}` }) });
			expect(res.status).toBe(200);
		}
		const res = await api(main, "/api/notices");
		const body = (await res.json()) as { notices: { message: string }[] };
		expect(body.notices.length).toBe(50);
		expect(body.notices[0]!.message).toBe("n54");
		expect(body.notices[49]!.message).toBe("n5");
	});
});
