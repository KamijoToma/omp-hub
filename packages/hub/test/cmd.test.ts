/**
 * Session-command channel (docs/protocol.md §2 "Session commands" + §3) against a hub
 * started in-process, with a fake agent daemon over a real WebSocket.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { startHub, type Hub } from "../src/server";

interface SessionJson {
	id: string;
	status: string;
	exitReason?: string;
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

const STATE = {
	sessionName: "demo",
	cwd: "/srv/state",
	model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	thinkingLevel: "high",
	thinkingLevels: ["off", "low", "medium", "high"],
	models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
};

/** `get-context` payload (protocol §2 SessionContext) as the session host reports it. */
const CONTEXT = {
	contextWindow: 200_000,
	usedTokens: 46_500,
	categories: [
		{ id: "systemPrompt", label: "System prompt", tokens: 1_200 },
		{ id: "systemTools", label: "System tools", tokens: 5_400 },
		{ id: "systemContext", label: "System context", tokens: 900 },
		{ id: "skills", label: "Skills", tokens: 600 },
		{ id: "messages", label: "Messages", tokens: 38_400 },
	],
	autoCompactBufferTokens: 20_000,
	freeTokens: 133_500,
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

async function sessionJson(ctx: Ctx, id: string): Promise<SessionJson> {
	const response = await api(ctx, `/api/sessions/${id}`);
	expect(response.status).toBe(200);
	return ((await response.json()) as { session: SessionJson }).session;
}

/** Polls the API until the record reaches `status`; the hub flips it on agent reports. */
async function waitForStatus(ctx: Ctx, id: string, status: string): Promise<SessionJson> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const session = await sessionJson(ctx, id);
		if (session.status === status) return session;
		if (Date.now() > deadline) throw new Error(`session ${id} stayed "${session.status}", expected "${status}"`);
		await yieldLoop();
	}
}

/** Starts a session on `machineId` and drives it to `live`. */
async function liveSession(ctx: Ctx, agent: FakeAgent, machineId: string, cwd: string): Promise<SessionJson> {
	const created = await api(ctx, "/api/sessions", { method: "POST", body: JSON.stringify({ machineId, cwd }) });
	expect(created.status).toBe(202);
	const session = ((await created.json()) as { session: SessionJson }).session;

	await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
	agent.ws.send(JSON.stringify({ t: "session-ready", id: session.id, links: LINKS }));
	return waitForStatus(ctx, session.id, "live");
}

/** Answers the next `cmd` frame with `result`; returns the frame for shape assertions. */
async function answerCmd(agent: FakeAgent, cmd: string, result: Record<string, unknown>): Promise<Record<string, unknown>> {
	const frame = await agent.wait((f) => (f.t === "cmd" ? f : undefined), `${cmd} frame`);
	expect(frame.cmd).toBe(cmd);
	agent.ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ...result }));
	return frame;
}

describe("session commands", () => {
	test("get-state relays the agent's AgentState back to the caller", async () => {
		const agent = await connectAgent(main, "m-state", "state-machine");
		const session = await liveSession(main, agent, "m-state", "/srv/state");

		const response = api(main, `/api/sessions/${session.id}/agent-state`);
		const frame = await answerCmd(agent, "get-state", { ok: true, data: STATE });
		expect(frame).toMatchObject({ id: session.id, cmd: "get-state" });
		expect(frame.reqId).toMatch(/^c_[0-9a-z]{10}$/);
		expect(frame).not.toHaveProperty("provider");

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, state: STATE });
	});

	test("get-context relays the agent's session context; the route needs the bearer token", async () => {
		const agent = await connectAgent(main, "m-context", "context-machine");
		const session = await liveSession(main, agent, "m-context", "/srv/context");

		const anon = await fetch(`${main.http}/api/sessions/${session.id}/context`);
		expect(anon.status).toBe(401);
		expect(await anon.json()).toEqual({ error: "unauthorized" });

		const response = api(main, `/api/sessions/${session.id}/context`);
		const frame = await answerCmd(agent, "get-context", { ok: true, data: CONTEXT });
		// A pure read: the frame carries no provider/modelId/level parameters.
		expect(frame).toEqual({ t: "cmd", id: session.id, reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/), cmd: "get-context" });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, context: CONTEXT });
	});

	test("set-model forwards provider/modelId and returns switched", async () => {
		const agent = await connectAgent(main, "m-model", "model-machine");
		const session = await liveSession(main, agent, "m-model", "/srv/model");

		const response = api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5" }),
		});
		const frame = await answerCmd(agent, "set-model", { ok: true, data: { switched: true, role: "default" } });
		expect(frame).toMatchObject({ id: session.id, provider: "openai", modelId: "gpt-5" });
		expect(frame).not.toHaveProperty("role");
		expect(frame).not.toHaveProperty("persist");

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, switched: true, role: "default", thinkingLevel: null });
	});

	test("set-model forwards the thinking level and relays the effective one", async () => {
		const agent = await connectAgent(main, "m-level", "level-machine");
		const session = await liveSession(main, agent, "m-level", "/srv/level");

		const response = api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5", level: "high" }),
		});
		const frame = await answerCmd(agent, "set-model", {
			ok: true,
			data: { switched: true, role: "default", thinkingLevel: "high" },
		});
		expect(frame).toMatchObject({ id: session.id, provider: "openai", modelId: "gpt-5", level: "high" });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, switched: true, role: "default", thinkingLevel: "high" });
	});

	test("set-model forwards role and persist for non-default roles", async () => {
		const agent = await connectAgent(main, "m-role", "role-machine");
		const session = await liveSession(main, agent, "m-role", "/srv/role");

		const response = api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5", role: "smol", persist: false }),
		});
		const frame = await answerCmd(agent, "set-model", { ok: true, data: { switched: true, role: "smol" } });
		expect(frame).toMatchObject({ id: session.id, provider: "openai", modelId: "gpt-5", role: "smol", persist: false });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, switched: true, role: "smol", thinkingLevel: null });
	});

	test("set-model validates role and persist before dispatching", async () => {
		const agent = await connectAgent(main, "m-role-bad", "role-bad-machine");
		const session = await liveSession(main, agent, "m-role-bad", "/srv/role-bad");

		const blank = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5", role: "  " }),
		});
		expect(blank.status).toBe(400);
		expect(await blank.json()).toEqual({ error: "invalid role" });

		const oversize = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5", role: "r".repeat(65) }),
		});
		expect(oversize.status).toBe(400);

		const badPersist = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5", persist: "yes" }),
		});
		expect(badPersist.status).toBe(400);
		expect(await badPersist.json()).toEqual({ error: "persist must be a boolean" });

		const blankLevel = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5", level: "  " }),
		});
		expect(blankLevel.status).toBe(400);
		expect(await blankLevel.json()).toEqual({ error: "invalid level" });
	});

	test("navigate-tree forwards entryId and returns the move result", async () => {
		const agent = await connectAgent(main, "m-tree", "tree-machine");
		const session = await liveSession(main, agent, "m-tree", "/srv/tree");

		const response = api(main, `/api/sessions/${session.id}/tree`, {
			method: "POST",
			body: JSON.stringify({ entryId: "e_42", summarize: true }),
		});
		const frame = await answerCmd(agent, "navigate-tree", {
			ok: true,
			data: { cancelled: false, aborted: false, editorText: "fix it", leafId: "e_9" },
		});
		expect(frame).toMatchObject({ id: session.id, cmd: "navigate-tree", entryId: "e_42", summarize: true });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({
			ok: true,
			cancelled: false,
			aborted: false,
			editorText: "fix it",
			leafId: "e_9",
		});
	});

	test("navigate-tree validates entryId before dispatching", async () => {
		const agent = await connectAgent(main, "m-tree-bad", "tree-bad-machine");
		const session = await liveSession(main, agent, "m-tree-bad", "/srv/tree-bad");

		const missing = await api(main, `/api/sessions/${session.id}/tree`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ error: "entryId is required" });

		const badSummarize = await api(main, `/api/sessions/${session.id}/tree`, {
			method: "POST",
			body: JSON.stringify({ entryId: "e_1", summarize: "yes" }),
		});
		expect(badSummarize.status).toBe(400);
		expect(await badSummarize.json()).toEqual({ error: "summarize must be a boolean" });
	});

	test("set-thinking forwards the level and returns the effective one", async () => {
		const agent = await connectAgent(main, "m-thinking", "thinking-machine");
		const session = await liveSession(main, agent, "m-thinking", "/srv/thinking");

		const response = api(main, `/api/sessions/${session.id}/thinking`, {
			method: "POST",
			body: JSON.stringify({ level: "low" }),
		});
		const frame = await answerCmd(agent, "set-thinking", { ok: true, data: { thinkingLevel: "medium" } });
		expect(frame).toMatchObject({ id: session.id, level: "low" });
		expect(frame).not.toHaveProperty("provider");

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, thinkingLevel: "medium" });
	});

	test("agent failures map to statuses: 500 passthrough, 409 unknown session", async () => {
		const agent = await connectAgent(main, "m-error", "error-machine");
		const session = await liveSession(main, agent, "m-error", "/srv/error");

		const failed = api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5" }),
		});
		await answerCmd(agent, "set-model", { ok: false, error: "no API key" });
		const errorResponse = await failed;
		expect(errorResponse.status).toBe(500);
		expect(await errorResponse.json()).toEqual({ error: "no API key" });

		const unknown = api(main, `/api/sessions/${session.id}/agent-state`);
		await answerCmd(agent, "get-state", { ok: false, error: "unknown session" });
		const taken = await unknown;
		expect(taken.status).toBe(409);
		expect(await taken.json()).toEqual({ error: "unknown session" });
	});

	test("commands are rejected with 409 unless the session is live", async () => {
		const agent = await connectAgent(main, "m-starting", "starting-machine");
		const created = await api(main, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ machineId: "m-starting", cwd: "/srv/starting" }),
		});
		const session = ((await created.json()) as { session: SessionJson }).session;
		expect(session.status).toBe("starting");

		const state = await api(main, `/api/sessions/${session.id}/agent-state`);
		expect(state.status).toBe(409);
		expect(await state.json()).toEqual({ error: "session is starting" });

		const context = await api(main, `/api/sessions/${session.id}/context`);
		expect(context.status).toBe(409);
		expect(await context.json()).toEqual({ error: "session is starting" });

		const model = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5" }),
		});
		expect(model.status).toBe(409);

		const thinking = await api(main, `/api/sessions/${session.id}/thinking`, {
			method: "POST",
			body: JSON.stringify({ level: "high" }),
		});
		expect(thinking.status).toBe(409);
	});

	test("model and thinking validate their bodies with 400", async () => {
		const agent = await connectAgent(main, "m-validate", "validate-machine");
		const session = await liveSession(main, agent, "m-validate", "/srv/validate");

		const noProvider = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ modelId: "gpt-5" }),
		});
		expect(noProvider.status).toBe(400);
		expect(await noProvider.json()).toEqual({ error: "provider is required" });

		const blankModel = await api(main, `/api/sessions/${session.id}/model`, {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "  " }),
		});
		expect(blankModel.status).toBe(400);
		expect(await blankModel.json()).toEqual({ error: "modelId is required" });

		const noLevel = await api(main, `/api/sessions/${session.id}/thinking`, { method: "POST", body: JSON.stringify({}) });
		expect(noLevel.status).toBe(400);
		expect(await noLevel.json()).toEqual({ error: "level is required" });

		const badJson = await api(main, `/api/sessions/${session.id}/thinking`, { method: "POST", body: "{" });
		expect(badJson.status).toBe(400);
		expect(await badJson.json()).toEqual({ error: "invalid json body" });

		const unknownState = await api(main, "/api/sessions/s_zzzzzzzzzz/agent-state");
		expect(unknownState.status).toBe(404);
		const unknownContext = await api(main, "/api/sessions/s_zzzzzzzzzz/context");
		expect(unknownContext.status).toBe(404);
		expect(await unknownContext.json()).toEqual({ error: "session not found" });
		const unknownModel = await api(main, "/api/sessions/s_zzzzzzzzzz/model", {
			method: "POST",
			body: JSON.stringify({ provider: "openai", modelId: "gpt-5" }),
		});
		expect(unknownModel.status).toBe(404);
	});

	test("a live session on an offline machine is 502", async () => {
		// A hub restart keeps the session store but drops the agent socket, so drive the
		// store directly: a live record whose machine never connected.
		const record = main.hub.sessions.create({ machineId: "m-offline", machineName: "offline-machine", cwd: "/srv/offline" });
		main.hub.sessions.markReady(record.id, {});

		const response = await api(main, `/api/sessions/${record.id}/agent-state`);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "agent offline" });
	});

	test("an unanswered command times out with 504", async () => {
		const timeoutCtx = startCluster({ cmdTimeoutMs: 100 });
		try {
			const agent = await connectAgent(timeoutCtx, "m-timeout", "timeout-machine");
			const session = await liveSession(timeoutCtx, agent, "m-timeout", "/srv/timeout");

			const response = api(timeoutCtx, `/api/sessions/${session.id}/agent-state`);
			await agent.wait((frame) => (frame.t === "cmd" ? frame : undefined), "cmd frame");

			// The agent never answers: the hub settles the call by itself.
			const timedOut = await response;
			expect(timedOut.status).toBe(504);
			expect(await timedOut.json()).toEqual({ error: "cmd timeout" });

			// The session itself is unaffected.
			expect((await sessionJson(timeoutCtx, session.id)).status).toBe("live");
		} finally {
			timeoutCtx.hub.stop();
		}
	});

	test("a disconnect mid-command fails the call with 502 and settles the pending request", async () => {
		const agent = await connectAgent(main, "m-mid", "mid-machine");
		const session = await liveSession(main, agent, "m-mid", "/srv/mid");

		const response = api(main, `/api/sessions/${session.id}/thinking`, {
			method: "POST",
			body: JSON.stringify({ level: "high" }),
		});
		await agent.wait((frame) => (frame.t === "cmd" ? frame : undefined), "cmd frame");

		agent.ws.close();
		const failed = await response;
		expect(failed.status).toBe(502);
		expect(await failed.json()).toEqual({ error: "agent disconnected" });

		// The lost agent took the session with it; later commands are 409, not 502.
		expect((await waitForStatus(main, session.id, "exited")).exitReason).toBe("agent disconnected");
		const after = await api(main, `/api/sessions/${session.id}/agent-state`);
		expect(after.status).toBe(409);
	});

	test("compact dispatches in the background and confirms the dispatch", async () => {
		const agent = await connectAgent(main, "m-compact", "compact-machine");
		const session = await liveSession(main, agent, "m-compact", "/srv/compact");

		const response = api(main, `/api/sessions/${session.id}/compact`, {
			method: "POST",
			body: JSON.stringify({ instructions: "focus on the failing tests", mode: "block" }),
		});
		const frame = await answerCmd(agent, "compact", { ok: true, data: { started: true } });
		expect(frame).toMatchObject({
			t: "cmd",
			id: session.id,
			cmd: "compact",
			instructions: "focus on the failing tests",
			mode: "block",
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true });
	});

	test("compact validates instructions and mode types", async () => {
		const agent = await connectAgent(main, "m-compact-bad", "compact-bad-machine");
		const session = await liveSession(main, agent, "m-compact-bad", "/srv/compact-bad");

		const badInstructions = await api(main, `/api/sessions/${session.id}/compact`, {
			method: "POST",
			body: JSON.stringify({ instructions: 7 }),
		});
		expect(badInstructions.status).toBe(400);
		expect(await badInstructions.json()).toEqual({ error: "instructions must be a string" });

		const badMode = await api(main, `/api/sessions/${session.id}/compact`, {
			method: "POST",
			body: JSON.stringify({ mode: { name: "block" } }),
		});
		expect(badMode.status).toBe(400);
		expect(await badMode.json()).toEqual({ error: "mode must be a string" });
	});

	test("retry reports started, and nothing-to-retry conflicts map to 409", async () => {
		const agent = await connectAgent(main, "m-retry", "retry-machine");
		const session = await liveSession(main, agent, "m-retry", "/srv/retry");

		const response = api(main, `/api/sessions/${session.id}/retry`, { method: "POST" });
		const frame = await answerCmd(agent, "retry", { ok: true, data: { started: true } });
		// No parameters: the frame is exactly the routing envelope.
		expect(frame).toEqual({ t: "cmd", id: session.id, reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/), cmd: "retry" });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, started: true });

		const nothing = api(main, `/api/sessions/${session.id}/retry`, { method: "POST" });
		await answerCmd(agent, "retry", { ok: false, error: "Nothing to retry." });
		const conflict = await nothing;
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "Nothing to retry." });

		const streaming = api(main, `/api/sessions/${session.id}/retry`, { method: "POST" });
		await answerCmd(agent, "retry", {
			ok: false,
			error: "Wait for the current response to finish or abort it before retrying.",
		});
		const busy = await streaming;
		expect(busy.status).toBe(409);
		expect(await busy.json()).toEqual({ error: "Wait for the current response to finish or abort it before retrying." });
	});

	test("retry maps the agent's started:false to a 409 conflict", async () => {
		const agent = await connectAgent(main, "m-retry-false", "retry-false-machine");
		const session = await liveSession(main, agent, "m-retry-false", "/srv/retry-false");

		const response = api(main, `/api/sessions/${session.id}/retry`, { method: "POST" });
		await answerCmd(agent, "retry", { ok: true, data: { started: false } });
		const settled = await response;
		expect(settled.status).toBe(409);
		expect(await settled.json()).toEqual({ error: "Nothing to retry." });
	});

	test("get-todos relays the branch phases without parameters", async () => {
		const agent = await connectAgent(main, "m-todos", "todos-machine");
		const session = await liveSession(main, agent, "m-todos", "/srv/todos");

		const phases = [
			{ title: "Setup", tasks: [{ text: "install deps", status: "done" }] },
			{ title: "Work", tasks: [{ text: "implement routes", status: "in_progress" }] },
		];
		const response = api(main, `/api/sessions/${session.id}/todos`);
		const frame = await answerCmd(agent, "get-todos", { ok: true, data: { phases } });
		expect(frame).toEqual({ t: "cmd", id: session.id, reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/), cmd: "get-todos" });

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, phases });
	});

	test("loop forwards enable config and echoes the loop status", async () => {
		const agent = await connectAgent(main, "m-loop", "loop-machine");
		const session = await liveSession(main, agent, "m-loop", "/srv/loop");

		const status = {
			state: "running",
			prompt: "keep polishing",
			limit: { kind: "iterations", iterations: 3, iterationsLeft: 3 },
			condition: { command: "bun test", until: true },
		};
		const response = api(main, `/api/sessions/${session.id}/loop`, {
			method: "POST",
			body: JSON.stringify({
				action: "enable",
				prompt: "keep polishing",
				limit: { iterations: 3 },
				condition: { command: "bun test", until: true },
			}),
		});
		const frame = await answerCmd(agent, "loop", { ok: true, data: { loop: status } });
		expect(frame).toMatchObject({
			t: "cmd",
			id: session.id,
			cmd: "loop",
			action: "enable",
			prompt: "keep polishing",
			limit: { iterations: 3 },
			condition: { command: "bun test", until: true },
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, loop: status });

		const statusResponse = api(main, `/api/sessions/${session.id}/loop`, {
			method: "POST",
			body: JSON.stringify({ action: "status" }),
		});
		const statusFrame = await answerCmd(agent, "loop", { ok: true, data: { loop: null } });
		expect(statusFrame).toEqual({
			t: "cmd",
			id: session.id,
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "loop",
			action: "status",
		});
		expect(await (await statusResponse).json()).toEqual({ ok: true, loop: null });
	});

	test("loop validates action, limit, and condition shapes", async () => {
		const agent = await connectAgent(main, "m-loop-bad", "loop-bad-machine");
		const session = await liveSession(main, agent, "m-loop-bad", "/srv/loop-bad");
		const post = (body: Record<string, unknown>): Promise<Response> =>
			api(main, `/api/sessions/${session.id}/loop`, { method: "POST", body: JSON.stringify(body) });

		const badAction = await post({ action: "frobnicate" });
		expect(badAction.status).toBe(400);
		expect(await badAction.json()).toEqual({ error: "action must be one of enable, disable, pause, resume, status" });

		const missingAction = await post({ prompt: "keep going" });
		expect(missingAction.status).toBe(400);

		const zeroIterations = await post({ action: "enable", prompt: "keep going", limit: { iterations: 0 } });
		expect(zeroIterations.status).toBe(400);
		expect(await zeroIterations.json()).toEqual({ error: "invalid limit" });

		const negativeDuration = await post({ action: "enable", limit: { durationMs: -5 } });
		expect(negativeDuration.status).toBe(400);

		const bothLimits = await post({ action: "enable", limit: { iterations: 2, durationMs: 100 } });
		expect(bothLimits.status).toBe(400);

		const stringLimit = await post({ action: "enable", limit: "3" });
		expect(stringLimit.status).toBe(400);

		const conditionWithoutUntil = await post({ action: "enable", condition: { command: "bun test" } });
		expect(conditionWithoutUntil.status).toBe(400);
		expect(await conditionWithoutUntil.json()).toEqual({ error: "invalid condition" });

		const blankConditionCommand = await post({ action: "enable", condition: { command: "  ", until: true } });
		expect(blankConditionCommand.status).toBe(400);

		const nonBooleanUntil = await post({ action: "enable", condition: { command: "bun test", until: "yes" } });
		expect(nonBooleanUntil.status).toBe(400);

		const blankPrompt = await post({ action: "enable", prompt: "  " });
		expect(blankPrompt.status).toBe(400);
		expect(await blankPrompt.json()).toEqual({ error: "invalid prompt" });
	});

	test("goal forwards actions and surfaces SDK failures via cmd-result mapping", async () => {
		const agent = await connectAgent(main, "m-goal", "goal-machine");
		const session = await liveSession(main, agent, "m-goal", "/srv/goal");

		const goal = { enabled: true, mode: "active", goal: { objective: "ship the release" } };
		const response = api(main, `/api/sessions/${session.id}/goal`, {
			method: "POST",
			body: JSON.stringify({ action: "set", objective: "ship the release", tokenBudget: 120_000 }),
		});
		const frame = await answerCmd(agent, "goal", { ok: true, data: { goal } });
		expect(frame).toMatchObject({
			t: "cmd",
			id: session.id,
			cmd: "goal",
			action: "set",
			objective: "ship the release",
			tokenBudget: 120_000,
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, goal });

		const drop = api(main, `/api/sessions/${session.id}/goal`, { method: "POST", body: JSON.stringify({ action: "drop" }) });
		const dropFrame = await answerCmd(agent, "goal", { ok: true, data: { goal: null } });
		expect(dropFrame).toEqual({
			t: "cmd",
			id: session.id,
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "goal",
			action: "drop",
		});
		expect(await (await drop).json()).toEqual({ ok: true, goal: null });

		// A budget without a number is the agent's call: its message wins (contract §3).
		const budget = api(main, `/api/sessions/${session.id}/goal`, { method: "POST", body: JSON.stringify({ action: "budget" }) });
		await answerCmd(agent, "goal", { ok: false, error: "budget requires a numeric tokenBudget" });
		const failed = await budget;
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "budget requires a numeric tokenBudget" });
	});

	test("goal validates action, objective, and tokenBudget", async () => {
		const agent = await connectAgent(main, "m-goal-bad", "goal-bad-machine");
		const session = await liveSession(main, agent, "m-goal-bad", "/srv/goal-bad");

		const badAction = await api(main, `/api/sessions/${session.id}/goal`, {
			method: "POST",
			body: JSON.stringify({ action: "win" }),
		});
		expect(badAction.status).toBe(400);
		expect(await badAction.json()).toEqual({ error: "action must be one of set, replace, pause, resume, drop, budget" });

		const missingObjective = await api(main, `/api/sessions/${session.id}/goal`, {
			method: "POST",
			body: JSON.stringify({ action: "set" }),
		});
		expect(missingObjective.status).toBe(400);
		expect(await missingObjective.json()).toEqual({ error: "objective is required" });

		const blankObjective = await api(main, `/api/sessions/${session.id}/goal`, {
			method: "POST",
			body: JSON.stringify({ action: "replace", objective: "   " }),
		});
		expect(blankObjective.status).toBe(400);
		expect(await blankObjective.json()).toEqual({ error: "invalid objective" });

		const negativeBudget = await api(main, `/api/sessions/${session.id}/goal`, {
			method: "POST",
			body: JSON.stringify({ action: "budget", tokenBudget: -1 }),
		});
		expect(negativeBudget.status).toBe(400);
		expect(await negativeBudget.json()).toEqual({ error: "tokenBudget must be a non-negative number" });

		const stringBudget = await api(main, `/api/sessions/${session.id}/goal`, {
			method: "POST",
			body: JSON.stringify({ action: "budget", tokenBudget: "many" }),
		});
		expect(stringBudget.status).toBe(400);
	});

	test("extended-context forwards enabled and relays the resulting state", async () => {
		const agent = await connectAgent(main, "m-extctx", "extctx-machine");
		const session = await liveSession(main, agent, "m-extctx", "/srv/extctx");

		const response = api(main, `/api/sessions/${session.id}/extended-context`, {
			method: "POST",
			body: JSON.stringify({ enabled: true }),
		});
		const frame = await answerCmd(agent, "set-extended-context", { ok: true, data: { extendedContext: true } });
		expect(frame).toEqual({
			t: "cmd",
			id: session.id,
			reqId: expect.stringMatching(/^c_[0-9a-z]{10}$/),
			cmd: "set-extended-context",
			enabled: true,
		});

		const settled = await response;
		expect(settled.status).toBe(200);
		expect(await settled.json()).toEqual({ ok: true, extendedContext: true });

		// No `enabled` key: the agent toggles and reports the new state.
		const toggle = api(main, `/api/sessions/${session.id}/extended-context`, { method: "POST", body: JSON.stringify({}) });
		const toggleFrame = await answerCmd(agent, "set-extended-context", { ok: true, data: { extendedContext: false } });
		expect("enabled" in toggleFrame).toBe(false);
		expect(await (await toggle).json()).toEqual({ ok: true, extendedContext: false });

		const badEnabled = await api(main, `/api/sessions/${session.id}/extended-context`, {
			method: "POST",
			body: JSON.stringify({ enabled: "on" }),
		});
		expect(badEnabled.status).toBe(400);
		expect(await badEnabled.json()).toEqual({ error: "enabled must be a boolean" });
	});
});
