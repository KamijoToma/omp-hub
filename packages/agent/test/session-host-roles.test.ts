/**
 * 0.10.0 model-role alignment (docs/protocol.md §2): `AgentState.roles[].auto`
 * auto-selection, `set-model` `clearRole` unassignment, and `cycle-model`
 * `roleCycle`. Role resolution runs against the real SDK resolver over an
 * isolated `Settings`; the session is a stub — no model calls, no network.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import * as modelRoles from "@oh-my-pi/pi-coding-agent/config/model-roles";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgCycleOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import * as roleModels from "@oh-my-pi/pi-coding-agent/session/role-models";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import { createLogger } from "../src/log";
import { type CommandFrame, agentRoles, executeCommand } from "../src/session-host";

type CommandDeps = Parameters<typeof executeCommand>[2];

/**
 * Priority-adjacent fixtures: "haiku" sits in the smol priority list, "opus-5"
 * in slow, "big" in neither — so auto-selection outcomes are deterministic.
 */
const MODELS: Model[] = [
	{ provider: "testprov", id: "haiku", name: "Haiku" },
	{ provider: "testprov", id: "opus-5", name: "Opus 5" },
	{ provider: "testprov", id: "big", name: "Big" },
] as unknown as Model[];

function roleDeps(): CommandDeps {
	return {
		modelRoles,
		roleModels,
		modelResolver,
		parseThinkingLevel: parseConfiguredThinkingLevel,
		cfgCycleOrder,
		log: createLogger("roles-test"),
	} as unknown as CommandDeps;
}

function stubSession(settings: Settings, extra: Record<string, unknown> = {}): AgentSessionStub {
	return {
		settings,
		model: MODELS[2]!,
		getAvailableModels: () => MODELS,
		scopedModels: [],
		get thinkingLevel() {
			return null;
		},
		...extra,
	} as never;
}

type AgentSessionStub = Parameters<typeof agentRoles>[0];

async function withIsolatedSettings(run: (settings: Settings) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-roles-"));
	try {
		const settings = await Settings.loadIsolated({ cwd: root, agentDir: path.join(root, "agent") });
		await run(settings);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function clearFrame(role: string): CommandFrame {
	return { t: "cmd", reqId: "r1", cmd: "set-model", role, clearRole: true };
}

test("agentRoles resolves unconfigured roles via auto-selection and flags them", async () => {
	await withIsolatedSettings(async settings => {
		const roles = agentRoles(stubSession(settings), MODELS, roleDeps());
		const byRole = new Map(roles.map(role => [role.role, role]));

		// smol/slow have priority lists — auto-resolved and flagged.
		expect(byRole.get("smol")).toMatchObject({ model: { provider: "testprov", id: "haiku" }, auto: true });
		expect(byRole.get("slow")).toMatchObject({ model: { provider: "testprov", id: "opus-5" }, auto: true });
		// task has no priority list, fallback, or default inheritance — stays null.
		expect(byRole.get("task")).toEqual({ role: "task", name: "Subtask", model: null, auto: false });
		// default falls back to the active session model and is flagged auto when
		// unconfigured (TUI parity — nothing to clear).
		expect(byRole.get("default")).toMatchObject({ model: { provider: "testprov", id: "big" }, auto: true });
	});
});

test("set-model clearRole drops the configured assignment and auto-selection returns", async () => {
	await withIsolatedSettings(async settings => {
		settings.setModelRole("smol", "testprov/opus-5");
		const session = stubSession(settings);
		expect(agentRoles(session, MODELS, roleDeps()).find(role => role.role === "smol")).toMatchObject({
			model: { id: "opus-5" },
			auto: false,
		});

		const result = await executeCommand(session, clearFrame("smol"), roleDeps(), {} as never);
		expect(result).toEqual({ switched: false, role: "smol", thinkingLevel: null });
		expect(settings.getModelRole("smol")).toBeUndefined();

		const after = agentRoles(session, MODELS, roleDeps());
		expect(after.find(role => role.role === "smol")).toMatchObject({
			model: { id: "haiku" },
			auto: true,
		});
	});
});

test("clearing the default role switches to the newly exposed persisted value", async () => {
	await withIsolatedSettings(async settings => {
		// A project-layer default shadows a global value; clearing the layer that
		// supplies the effective value exposes the global one, and the live model
		// follows it without a settings write-back.
		settings.setModelRole("default", "testprov/big");
		settings.setProjectModelRole("default", "testprov/haiku");
		const switches: Array<{ model: Model | undefined; role: string; opts: unknown }> = [];
		const session = stubSession(settings, {
			setModel: async (model: Model, role: string, opts: unknown) => {
				switches.push({ model, role, opts });
				return { switched: true };
			},
			get thinkingLevel() {
				return "high";
			},
		});

		const result = await executeCommand(session, clearFrame("default"), roleDeps(), {} as never);
		expect(result).toEqual({ switched: true, role: "default", thinkingLevel: "high" });
		expect(settings.getModelRole("default")).toBe("testprov/big");
		// The exposed global value (big) — not the cleared project one (haiku) —
		// becomes the live model.
		expect(switches).toEqual([{ model: MODELS[2], role: "default", opts: { persist: false } }]);
	});
});

test("set-model clearRole validates the role like the switch path", async () => {
	await withIsolatedSettings(async settings => {
		const session = stubSession(settings);
		await expect(
			executeCommand(session, clearFrame("x".repeat(65)), roleDeps(), {} as never),
		).rejects.toThrow("invalid model role");
	});
});

test("cycle-model roleCycle cycles configured role models without settings writes", async () => {
	await withIsolatedSettings(async settings => {
		settings.setModelRole("smol", "testprov/haiku");
		settings.setModelRole("slow", "testprov/opus-5");
		const cycles: Array<{ order: readonly string[]; direction: string }> = [];
		const session = stubSession(settings, {
			cycleRoleModels: async (order: readonly string[], direction: string) => {
				cycles.push({ order, direction });
				return { model: MODELS[1], thinkingLevel: "high", role: "slow" };
			},
		});

		const result = await executeCommand(
			session,
			{ t: "cmd", reqId: "r1", cmd: "cycle-model", roleCycle: true },
			roleDeps(),
			{} as never,
		);
		expect(result).toEqual({
			switched: true,
			model: { provider: "testprov", id: "opus-5", name: "Opus 5" },
			thinkingLevel: "high",
		});
		expect(cycles).toEqual([{ order: cfgCycleOrder.get(settings), direction: "forward" }]);
	});
});

test("cycle-model roleCycle reports switched false on an empty cycle and validates direction", async () => {
	await withIsolatedSettings(async settings => {
		const session = stubSession(settings, {
			cycleRoleModels: async () => undefined,
		});

		const result = await executeCommand(
			session,
			{ t: "cmd", reqId: "r1", cmd: "cycle-model", roleCycle: true },
			roleDeps(),
			{} as never,
		);
		expect(result).toEqual({ switched: false, model: null, thinkingLevel: null });

		await expect(
			executeCommand(
				session,
				{ t: "cmd", reqId: "r2", cmd: "cycle-model", roleCycle: true, direction: "sideways" },
				roleDeps(),
				{} as never,
			),
		).rejects.toThrow("invalid cycle direction");
	});
});
