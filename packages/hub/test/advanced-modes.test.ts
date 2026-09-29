/**
 * Advanced session modes (docs/protocol.md §2/§3, revision 0.9.0): prewalk,
 * plan, advisor, tier, pause, cycle, settings, and the `start.prewalk` /
 * `start.planYolo` passthrough — against a hub started in-process on an
 * ephemeral port with a fake agent daemon over a real WebSocket.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHub, type Hub } from "../src/server";

let hub: Hub;
let httpBase: string;

beforeAll(() => {
	hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	httpBase = hub.url;
});

afterAll(() => {
	hub.stop();
});

const AUTH = { authorization: "Bearer t", "content-type": "application/json" };

function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${httpBase}${path}`, { headers: AUTH, ...init });
}

/** Yields the event loop so pending socket I/O can be processed (no fixed delay). */
const yieldLoop = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

interface FakeAgent {
	readonly ws: WebSocket;
	readonly frames: Record<string, unknown>[];
	wait<T>(match: (frame: Record<string, unknown>) => T | undefined, what: string): Promise<T>;
}

async function connectAgent(machineId: string, name: string): Promise<FakeAgent> {
	const ws = new WebSocket(`${httpBase.replace(/^http/, "ws")}/agent`, { headers: { authorization: "Bearer t" } });
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
			if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}; frames: ${JSON.stringify(frames)}`);
			await yieldLoop();
		}
	};

	ws.send(JSON.stringify({ t: "hello", name, machineId, version: "test" }));
	await wait((frame) => (frame.t === "welcome" ? frame : undefined), "welcome");
	return { ws, frames, wait };
}

interface SessionJson {
	id: string;
	status: string;
}

async function startSession(machineId: string, cwd: string, extra: Record<string, unknown> = {}): Promise<SessionJson> {
	const response = await api("/api/sessions", { method: "POST", body: JSON.stringify({ machineId, cwd, ...extra }) });
	expect(response.status).toBe(202);
	const body = (await response.json()) as { session: SessionJson };
	return body.session;
}

async function waitForStatus(id: string, status: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const response = await api(`/api/sessions/${id}`);
		const session = ((await response.json()) as { session: SessionJson }).session;
		if (session.status === status) return;
		if (Date.now() > deadline) throw new Error(`session ${id} stayed "${session.status}", expected "${status}"`);
		await yieldLoop();
	}
}

/** One cmd round trip: fire the request, poll frames for the dispatch, answer it. */
async function cmdRoundTrip(
	agent: FakeAgent,
	sessionId: string,
	path: string,
	cmd: string,
	opts: { method?: "GET" | "POST"; body?: Record<string, unknown>; data?: unknown; fail?: { error: string } } = {},
): Promise<{ status: number; json: Record<string, unknown>; frame: Record<string, unknown> }> {
	const seenFrames = agent.frames.length;
	const pending = api(`/api/sessions/${sessionId}${path}`, {
		method: opts.method ?? "POST",
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
	});
	const deadline = Date.now() + 4_000;
	let frame: Record<string, unknown> | undefined;
	for (;;) {
		frame = agent.frames
			.slice(seenFrames)
			.find((candidate) => candidate.t === "cmd" && candidate.cmd === cmd) as Record<string, unknown> | undefined;
		if (frame !== undefined || Date.now() > deadline) break;
		await yieldLoop();
	}
	if (frame === undefined) throw new Error(`timeout waiting for ${cmd}`);
	agent.ws.send(
		JSON.stringify(
			opts.fail === undefined
				? { t: "cmd-result", reqId: frame.reqId, ok: true, data: opts.data ?? {} }
				: { t: "cmd-result", reqId: frame.reqId, ok: false, error: opts.fail.error },
		),
	);
	const response = await pending;
	return { status: response.status, json: (await response.json()) as Record<string, unknown>, frame };
}

describe("advanced session modes", () => {
	test("POST /api/sessions forwards prewalk/planYolo on the start frame; bad types are 400", async () => {
		const agent = await connectAgent("m-advstart", "advstart-machine");
		const session = await startSession("m-advstart", "/srv/advstart", { prewalk: "@smol", planYolo: true });
		const start = await agent.wait((frame) => (frame.t === "start" ? frame : undefined), "start frame");
		expect(start).toMatchObject({ id: session.id, prewalk: "@smol", planYolo: true });
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "test done" }));

		for (const body of [{ prewalk: 5 }, { prewalk: "" }, { planYolo: {} }, { planYolo: null }]) {
			const bad = await api("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ machineId: "m-advstart", cwd: "/srv/x", ...body }),
			});
			expect(bad.status).toBe(400);
		}
	});

	test("advanced mode endpoints dispatch cmds, validate hub-side, and map agent errors", async () => {
		const agent = await connectAgent("m-adv", "adv-machine");
		const session = await startSession("m-adv", "/srv/adv");
		agent.ws.send(
			JSON.stringify({ t: "session-ready", id: session.id, links: { full: "a", view: "b", web: "c", webView: "d" } }),
		);
		await waitForStatus(session.id, "live");

		// prewalk arm: frame carries the validated fields, reply adds `armed`.
		const arm = await cmdRoundTrip(agent, session.id, "/prewalk", "prewalk", {
			body: { action: "arm", target: "@fast", level: "high" },
			data: { armed: true, prewalk: { provider: "p", id: "m", name: "M", thinkingLevel: "high" } },
		});
		expect(arm.status).toBe(200);
		expect(arm.frame).toMatchObject({ cmd: "prewalk", action: "arm", target: "@fast", level: "high" });
		expect(arm.json).toEqual({ ok: true, prewalk: { provider: "p", id: "m", name: "M", thinkingLevel: "high" }, armed: true });

		// prewalk restart: reply carries `result` instead of `armed`.
		const restart = await cmdRoundTrip(agent, session.id, "/prewalk", "prewalk", {
			body: { action: "restart" },
			data: { result: "armed", prewalk: { provider: "p", id: "m", name: "M", thinkingLevel: null } },
		});
		expect(restart.status).toBe(200);
		expect(restart.json).toEqual({
			ok: true,
			prewalk: { provider: "p", id: "m", name: "M", thinkingLevel: null },
			result: "armed",
		});

		// prewalk state (bare): just the projection.
		const state = await cmdRoundTrip(agent, session.id, "/prewalk", "prewalk", {
			body: {},
			data: { prewalk: null },
		});
		expect(state.status).toBe(200);
		expect(state.json).toEqual({ ok: true, prewalk: null });

		for (const body of [{ action: "bogus" }, { target: 42 }, { level: 42 }, { action: "arm", target: null }]) {
			const bad = await api(`/api/sessions/${session.id}/prewalk`, { method: "POST", body: JSON.stringify(body) });
			expect(bad.status).toBe(400);
		}

		// plan enable with an explicit file path.
		const plan = await cmdRoundTrip(agent, session.id, "/plan", "plan", {
			body: { action: "enable", planFilePath: "/tmp/plan.md" },
			data: { plan: { enabled: true, planFilePath: "/tmp/plan.md", workflow: null } },
		});
		expect(plan.status).toBe(200);
		expect(plan.frame).toMatchObject({ cmd: "plan", action: "enable", planFilePath: "/tmp/plan.md" });
		expect(plan.json).toEqual({ ok: true, plan: { enabled: true, planFilePath: "/tmp/plan.md", workflow: null } });

		for (const body of [{ action: "toggle" }, { planFilePath: 7 }]) {
			const bad = await api(`/api/sessions/${session.id}/plan`, { method: "POST", body: JSON.stringify(body) });
			expect(bad.status).toBe(400);
		}

		// advisor enable.
		const advisor = await cmdRoundTrip(agent, session.id, "/advisor", "advisor", {
			body: { action: "enable" },
			data: { enabled: true, advisors: ["critic"] },
		});
		expect(advisor.status).toBe(200);
		expect(advisor.frame).toMatchObject({ cmd: "advisor", action: "enable" });
		expect(advisor.json).toEqual({ ok: true, enabled: true, advisors: ["critic"] });

		const badAdvisor = await api(`/api/sessions/${session.id}/advisor`, {
			method: "POST",
			body: JSON.stringify({ action: "on" }),
		});
		expect(badAdvisor.status).toBe(400);

		// tier set: per-family values validated hub-side.
		const tier = await cmdRoundTrip(agent, session.id, "/tier", "tier", {
			body: { action: "set", family: "openai", tier: "priority" },
			data: { tiers: { openai: "priority" } },
		});
		expect(tier.status).toBe(200);
		expect(tier.frame).toMatchObject({ cmd: "tier", action: "set", family: "openai", tier: "priority" });
		expect(tier.json).toEqual({ ok: true, tiers: { openai: "priority" } });

		// tier with the family omitted resolves agent-side (current model's family).
		const tierBare = await cmdRoundTrip(agent, session.id, "/tier", "tier", {
			body: { action: "set", tier: "flex" },
			data: { tiers: { openai: "flex" } },
		});
		expect(tierBare.status).toBe(200);
		expect(tierBare.frame).toMatchObject({ cmd: "tier", action: "set", tier: "flex" });

		for (const body of [
			{ action: "raise" },
			{ family: "mistral" },
			{ family: "anthropic", tier: "flex" },
			{ tier: 3 },
		]) {
			const bad = await api(`/api/sessions/${session.id}/tier`, { method: "POST", body: JSON.stringify(body) });
			expect(bad.status).toBe(400);
		}

		// "family omitted with no current model" is agent-reported → 400.
		const noModel = await cmdRoundTrip(agent, session.id, "/tier", "tier", {
			body: { action: "set", tier: "priority" },
			fail: { error: "no current model" },
		});
		expect(noModel.status).toBe(400);

		// pause with an explicit state, then a non-boolean 400.
		const pause = await cmdRoundTrip(agent, session.id, "/pause", "pause", {
			body: { enabled: true },
			data: { paused: true },
		});
		expect(pause.status).toBe(200);
		expect(pause.frame).toMatchObject({ cmd: "pause", enabled: true });
		expect(pause.json).toEqual({ ok: true, paused: true });
		const badPause = await api(`/api/sessions/${session.id}/pause`, {
			method: "POST",
			body: JSON.stringify({ enabled: "yes" }),
		});
		expect(badPause.status).toBe(400);

		// cycle-model backward.
		const cycle = await cmdRoundTrip(agent, session.id, "/cycle", "cycle-model", {
			body: { direction: "backward" },
			data: { switched: true, model: { provider: "p", id: "m2", name: "M2" }, thinkingLevel: "low" },
		});
		expect(cycle.status).toBe(200);
		expect(cycle.frame).toMatchObject({ cmd: "cycle-model", direction: "backward" });
		expect(cycle.json).toEqual({
			ok: true,
			switched: true,
			model: { provider: "p", id: "m2", name: "M2" },
			thinkingLevel: "low",
		});
		const badCycle = await api(`/api/sessions/${session.id}/cycle`, {
			method: "POST",
			body: JSON.stringify({ direction: "sideways" }),
		});
		expect(badCycle.status).toBe(400);

		// settings listing rides verbatim.
		const settings = await cmdRoundTrip(agent, session.id, "/settings", "get-settings", {
			method: "GET",
			data: { settings: [{ id: "compaction.thresholdPercent", value: 80, type: "number" }] },
		});
		expect(settings.status).toBe(200);
		expect(settings.json).toEqual({
			ok: true,
			settings: [{ id: "compaction.thresholdPercent", value: 80, type: "number" }],
		});

		// set-setting: frame carries the id and the JSON value verbatim (null clears).
		const setSetting = await cmdRoundTrip(agent, session.id, "/settings", "set-setting", {
			body: { settingId: "compaction.thresholdPercent", value: 90 },
			data: { setting: { id: "compaction.thresholdPercent", value: 90, overridden: true } },
		});
		expect(setSetting.status).toBe(200);
		expect(setSetting.frame).toMatchObject({ cmd: "set-setting", settingId: "compaction.thresholdPercent", value: 90 });
		expect(setSetting.json).toEqual({
			ok: true,
			setting: { id: "compaction.thresholdPercent", value: 90, overridden: true },
		});

		const clearSetting = await cmdRoundTrip(agent, session.id, "/settings", "set-setting", {
			body: { settingId: "compaction.thresholdPercent", value: null },
			data: { setting: { id: "compaction.thresholdPercent", value: 80, overridden: false } },
		});
		expect(clearSetting.status).toBe(200);
		expect(clearSetting.frame).toMatchObject({ cmd: "set-setting", value: null });

		// hub-side 400s: missing settingId, absent value key.
		for (const body of [{ value: 1 }, { settingId: "x" }]) {
			const bad = await api(`/api/sessions/${session.id}/settings`, { method: "POST", body: JSON.stringify(body) });
			expect(bad.status).toBe(400);
		}

		// agent-reported unknown id / type mismatch → 400.
		const unknownId = await cmdRoundTrip(agent, session.id, "/settings", "set-setting", {
			body: { settingId: "nope", value: 1 },
			fail: { error: "unknown setting id: nope" },
		});
		expect(unknownId.status).toBe(400);
		const badType = await cmdRoundTrip(agent, session.id, "/settings", "set-setting", {
			body: { settingId: "compaction.thresholdPercent", value: "high" },
			fail: { error: "value must be a number" },
		});
		expect(badType.status).toBe(400);

		// A finished session is 409 for the new endpoints like every other cmd route.
		agent.ws.send(JSON.stringify({ t: "session-exit", id: session.id, code: 0, reason: "test done" }));
		await waitForStatus(session.id, "exited");
		expect((await api(`/api/sessions/${session.id}/settings`)).status).toBe(409);
		expect((await api(`/api/sessions/${session.id}/prewalk`, { method: "POST", body: "{}" })).status).toBe(409);
	});
});
