/**
 * 0.9.0 advanced session modes against the real session host (docs/protocol.md
 * §2/§4): prewalk / plan / advisor / tier / pause / cycle-model / get-settings /
 * set-setting, plus the five new AgentState fields and `start.prewalk`
 * passthrough. No model is needed — everything here is local state on a fresh
 * session. The relay is an in-process WS stub: the host only needs the socket
 * to open before it reports ready.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/log";
import { settingsWire, applySettingOverride } from "../src/settings-gateway";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

interface CommandOutcome {
	ok: boolean;
	data?: unknown;
	error?: string;
}

test("settings gateway roundtrip on a real isolated Settings", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-gateway-"));
	try {
		const settings = await Settings.loadIsolated({ cwd: root, agentDir: path.join(root, "agent") });
		const rows = settingsWire(settings);
		expect(rows.length).toBeGreaterThan(0);
		const compaction = rows.find(row => row.id === "compaction.enabled");
		expect(compaction).toMatchObject({ type: "boolean", overridden: false });
		expect(compaction?.defaultValue).toBeDefined();

		// set → wire shows the new value + overridden; get-state-style read matches.
		const applied = applySettingOverride(settings, "compaction.enabled", false);
		expect(applied).toMatchObject({ id: "compaction.enabled", value: false, overridden: true });

		// null clears the override (value returns to the configured/default read).
		const cleared = applySettingOverride(settings, "compaction.enabled", null);
		expect(cleared.overridden).toBe(false);

		// unknown/disallowed id and type mismatch fail with stable errors.
		expect(() => applySettingOverride(settings, "modelRoles.default", "x")).toThrow(/unknown or disallowed/);
		expect(() => applySettingOverride(settings, "compaction.thresholdPercent", "high")).toThrow(/expects/);
		expect(() => applySettingOverride(settings, "compaction.enabled", "yes")).toThrow(/expects a boolean/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("advanced mode cmds and AgentState extensions on a live session", async () => {
	const relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 })),
		websocket: {
			open() {},
			message() {},
			close() {},
		},
	});

	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-modes-host-"));
	await mkdir(path.join(root, "project"));
	await mkdir(path.join(root, "agent"));
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const exits: string[] = [];
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => exits.push(error),
			onExit: (_id, _code, reason) => exits.push(reason),
		},
		createLogger("modes-host-test"),
		{ hostEntry: HOST_ENTRY },
	);

	try {
		await supervisor.spawn({
			id: "s_modes01",
			cwd: path.join(root, "project"),
			agentDir: path.join(root, "agent"),
			relayUrl: `ws://127.0.0.1:${relay.port}`,
			webUrl: "",
			// 0.9.0 startup passthrough: an unresolvable pattern must never fail
			// the start (protocol §2 — warning, then start without the hand-off).
			prewalk: "@definitely-not-a-real-model",
		});
		await ready.promise;
		expect(exits).toEqual([]);

		const cmd = (reqId: string, frame: Record<string, unknown>): Promise<CommandOutcome> =>
			supervisor.cmd("s_modes01", { reqId, cmd: "", ...frame }) as Promise<CommandOutcome>;

		// get-state: the five 0.9.0 fields exist with inactive defaults.
		const state = await cmd("c_m001", { cmd: "get-state" });
		expect(state.ok).toBe(true);
		expect(state.data).toMatchObject({
			prewalk: null,
			plan: null,
			advisor: { enabled: false },
			paused: false,
			tiers: {},
		});

		// prewalk: bare/state reports null; an unresolvable target fails cleanly.
		const prewalkState = await cmd("c_m002", { cmd: "prewalk" });
		expect(prewalkState.data).toEqual({ prewalk: null });
		const badTarget = await cmd("c_m003", { cmd: "prewalk", action: "arm", target: "@no-such-role-xyz" });
		expect(badTarget.ok).toBe(false);
		expect(badTarget.error).toContain("not found");
		const badLevel = await cmd("c_m004", { cmd: "prewalk", action: "arm", target: "@smol", level: "loud" });
		expect(badLevel.ok).toBe(false);
		expect(badLevel.error).toContain("invalid thinking level");

		// plan: enable (SDK default path), explicit path, then disable.
		const planOn = await cmd("c_m005", { cmd: "plan", action: "enable" });
		expect(planOn.data).toEqual({ plan: { enabled: true, planFilePath: "local://PLAN.md", workflow: null } });
		const planPath = await cmd("c_m006", { cmd: "plan", action: "enable", planFilePath: "local://CUSTOM.md" });
		expect(planPath.data).toEqual({ plan: { enabled: true, planFilePath: "local://CUSTOM.md", workflow: null } });
		const planStatus = await cmd("c_m007", { cmd: "plan" });
		expect(planStatus.data).toEqual({ plan: { enabled: true, planFilePath: "local://CUSTOM.md", workflow: null } });
		const planOff = await cmd("c_m008", { cmd: "plan", action: "disable" });
		expect(planOff.data).toEqual({ plan: null });
		const badPlanPath = await cmd("c_m009", { cmd: "plan", action: "enable", planFilePath: 42 });
		expect(badPlanPath.ok).toBe(false);
		const badPlanAction = await cmd("c_m010", { cmd: "plan", action: "explode" });
		expect(badPlanAction.ok).toBe(false);
		expect(badPlanAction.error).toContain("unknown plan action");

		// advisor: an empty roster refuses enable; status reports disabled.
		const advisorEnable = await cmd("c_m011", { cmd: "advisor", action: "enable" });
		expect(advisorEnable.ok).toBe(false);
		expect(advisorEnable.error).toContain("no advisor configs");
		const advisorStatus = await cmd("c_m012", { cmd: "advisor" });
		expect(advisorStatus.data).toEqual({ enabled: false, advisors: [] });

		// tier: no model selected → stable error; invalid family never reached;
		// status reports the empty tier map; unknown action fails.
		const tierSet = await cmd("c_m013", { cmd: "tier", action: "set", family: "openai", tier: "priority" });
		expect(tierSet.ok).toBe(false);
		expect(tierSet.error).toContain("tier requires a selected model");
		const tierStatus = await cmd("c_m014", { cmd: "tier" });
		expect(tierStatus.data).toEqual({ tiers: {} });
		const badTierAction = await cmd("c_m015", { cmd: "tier", action: "boost" });
		expect(badTierAction.ok).toBe(false);
		expect(badTierAction.error).toContain("unknown tier action");

		// pause: toggle on, explicit off; non-boolean enabled is a caller bug.
		const paused = await cmd("c_m016", { cmd: "pause" });
		expect(paused.data).toEqual({ paused: true });
		const resumed = await cmd("c_m017", { cmd: "pause", enabled: false });
		expect(resumed.data).toEqual({ paused: false });
		const badPause = await cmd("c_m018", { cmd: "pause", enabled: "yes" });
		expect(badPause.ok).toBe(false);

		// cycle-model: no models in scope → switched:false; bad direction fails.
		const cycled = await cmd("c_m019", { cmd: "cycle-model" });
		expect(cycled.data).toEqual({ switched: false, model: null, thinkingLevel: null });
		const badDirection = await cmd("c_m020", { cmd: "cycle-model", direction: "sideways" });
		expect(badDirection.ok).toBe(false);
		expect(badDirection.error).toContain("invalid cycle direction");

		// get-settings / set-setting over the live session.
		const settings = await cmd("c_m021", { cmd: "get-settings" });
		expect(settings.ok).toBe(true);
		const payload: unknown = settings.data;
		if (!payload || typeof payload !== "object" || !("settings" in payload) || !Array.isArray(payload.settings)) {
			throw new Error("get-settings payload missing settings array");
		}
		const rows = payload.settings as Array<Record<string, unknown>>;
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.find(row => row.id === "compaction.enabled")).toMatchObject({ type: "boolean", overridden: false });
		const overridden = await cmd("c_m022", { cmd: "set-setting", settingId: "compaction.enabled", value: false });
		expect(overridden.data).toMatchObject({ setting: { id: "compaction.enabled", value: false, overridden: true } });
		const cleared = await cmd("c_m023", { cmd: "set-setting", settingId: "compaction.enabled", value: null });
		expect(cleared.data).toMatchObject({ setting: { overridden: false } });
		const unknownId = await cmd("c_m024", { cmd: "set-setting", settingId: "modelRoles.default", value: "x" });
		expect(unknownId.ok).toBe(false);
		expect(unknownId.error).toContain("unknown or disallowed setting");
		const typeMismatch = await cmd("c_m025", { cmd: "set-setting", settingId: "compaction.enabled", value: "yes" });
		expect(typeMismatch.ok).toBe(false);
		expect(typeMismatch.error).toContain("expects a boolean");

		// get-state mirrors the applied override and the pause state set above.
		const after = await cmd("c_m026", { cmd: "get-state" });
		expect(after.data).toMatchObject({ advisor: { enabled: false }, paused: false, tiers: {} });
	} finally {
		await supervisor.stopAll("test done");
		await rm(root, { recursive: true, force: true }).catch(() => {});
		await relay.stop(true);
	}
}, 120_000);
