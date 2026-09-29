/**
 * Session host: one child process per session (docs/architecture.md §2).
 *
 * argv: `--config <json>` with { id, cwd, name?, prompt?, relayUrl, webUrl, agentDir? }.
 * stdout is a JSONL frame channel (docs/protocol.md §4) — `ready` | `error` — and
 * nothing else; every log line goes to stderr.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type * as ModelRoles from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type {
	MCPHttpServerConfig,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { evaluateLoopCondition } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { COMPACT_MODES } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import type { cfgCycleOrder as CfgCycleOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { computeSessionContextBreakdown } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import type { ShakeMode } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import type { SessionEntry as StoredSessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type * as RoleModels from "@oh-my-pi/pi-coding-agent/session/role-models";
import type { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { cfgExtendedContext as CfgExtendedContext } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { parseConfiguredThinkingLevel as ParseThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { AgentPauseGate } from "@oh-my-pi/pi-agent-core/pause";
import type { serviceTierFamily as ServiceTierFamilyFn } from "@oh-my-pi/pi-ai/types";
import type * as ModelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type * as ServiceTierConfig from "@oh-my-pi/pi-coding-agent/config/service-tier";
import type * as AdvisorDiscovery from "@oh-my-pi/pi-coding-agent/advisor/config";
import type * as SettingsGateway from "./settings-gateway";
import { buildCollabCtx, sessionContextPayload } from "./collab-ctx";
import { createFleetClient, pageFleetMessages, searchFleetMessages } from "./fleet-client";
import { buildFleetTools } from "./fleet-tools";
import { createLogger, errorMessage, type Logger } from "./log";
import type { SessionLinks } from "./supervisor";
import type { LoopConditionConfig, LoopStatus } from "./session-loop";
import { SessionLoop, type LoopLimitConfig } from "./session-loop";
import type { FleetInputBridge } from "./ui-bridge";

interface HostConfig {
	id: string;
	cwd: string;
	name?: string;
	prompt?: string;
	/** Resume this omp session file instead of minting a new session. */
	sessionFile?: string;
	/** 0.8.0: fleet-operator session — registers the fleet tools and may issue `fleet-req`. */
	superagent?: boolean;
	/** 0.9.0: callable-tool whitelist; omitted means the SDK's default tool set. */
	tools?: string[];
	/** 0.9.0: arm the one-shot prewalk hand-off at startup; `true` = `@smol`, a string = explicit pattern. */
	prewalk?: boolean | string;
	/** 0.9.0: start in plan mode with the hand-off target; `true` = `@smol`, a string = explicit pattern. */
	planYolo?: boolean | string;
	relayUrl: string;
	webUrl: string;
	agentDir?: string;
}

type ReadyFrame = { t: "ready"; sessionFile: string; pid: number; links: SessionLinks };

/** Parent → child `cmd` frame (protocol §4). Known parameters are documented
 * here; unknown ones pass through untouched (executeCommand validates). */
export type CommandFrame = {
	t: "cmd";
	reqId: string;
	cmd: string;
	provider?: string;
	modelId?: string;
	/** `set-model` target role; omitted means `"default"`. */
	role?: string;
	/** `set-model`: persist a non-default role assignment (default true). */
	persist?: boolean;
	/** `set-model` (0.10.0+): clear the role's persisted assignment — auto-selection applies. */
	clearRole?: boolean;
	/** `set-thinking` level. */
	level?: string;
	/** `navigate-tree` target entry. */
	entryId?: string;
	/** `navigate-tree`: build a branch summary (default false). */
	summarize?: boolean;
	/** `compact`/`handoff`: directed-summary instructions (optional). */
	instructions?: string;
	/** `compact`/`shake`: one-off mode name (`COMPACT_MODES` / `elide|images|thinking`). */
	mode?: string;
	/** `loop`/`goal`: action selector. */
	action?: string;
	/** `goal` set/replace: objective text. */
	objective?: string;
	/** `goal`: token budget (optional on set/replace; required by `budget`). */
	tokenBudget?: number;
	/** `loop` enable: prompt to repeat (optional — waiting state allowed). */
	prompt?: string;
	/** `loop` enable: iteration/duration budget. */
	limit?: LoopLimitConfig;
	/** `loop` enable: continue-condition. */
	condition?: LoopConditionConfig;
	/** `set-extended-context`: target state; omitted toggles. */
	enabled?: boolean;
	/** `upload-file` client-supplied file name (sanitized before writing), `rename` target name (protocol §2),
	 * or the `mcp-*` target server name. */
	name?: string;
	/** `upload-file` payload, base64. */
	dataB64?: string;
	/** `mcp-add`/`mcp-remove` config scope; omitted means `"project"`. */
	scope?: string;
	/** `mcp-add` remote server URL (http/sse transport). */
	url?: string;
	/** `mcp-add` remote transport; omitted means `"http"`. */
	transport?: string;
	/** `mcp-add` bearer token folded into the config's Authorization header. */
	token?: string;
	/** `mcp-add` stdio command (exclusive with `url`). */
	command?: string;
	/** `mcp-add` stdio command arguments. */
	args?: string[];
	/** `prompt`: text delivered to the session via `session.prompt()`. */
	text?: string;
	/** Fleet message: start, steer, or follow_up. */
	messageMode?: "start" | "steer" | "follow_up";
	/** Fleet transcript page cursor and bound. */
	cursor?: string;
	pageLimit?: number;
	/** Search the active fleet branch: optional literal needle and timestamp bounds. */
	query?: string;
	from?: string;
	to?: string;
	/** Fleet UI response correlation. */
	requestId?: string;
	answer?: string;
	/** Fleet interrupt: withdraw queued work before abort. */
	clearQueue?: boolean;
	/** `prewalk` target model/role pattern; omitted means the SDK default target (`@smol`). */
	target?: string;
	/** `cycle-model` cycle direction (`forward` default). */
	direction?: string;
	/** `cycle-model` (0.10.0+): cycle the configured role models (`cycleOrder`) instead of the model list. */
	roleCycle?: boolean;
	/** `tier` target family; omitted derives from the current model. */
	family?: string;
	/** `tier` service-tier value (`"none"` clears). */
	tier?: string;
	/** `plan` explicit plan file path; omitted uses the SDK reference path. */
	planFilePath?: string;
	/** `set-setting` target descriptor id. */
	settingId?: string;
	/** `set-setting` override value; `null` clears the override. */
	value?: unknown;
};

/** Child → parent answer; exactly one per `cmd` (protocol §4). */
type CommandResultFrame =
	| { t: "cmd-result"; reqId: string; ok: true; data: unknown }
	| { t: "cmd-result"; reqId: string; ok: false; error: string };

/** Child → parent activity sample, emitted only on change (protocol §4). */
type ActivityFrame = { t: "activity"; working: boolean; inputRequired: boolean; name?: string; handoff?: boolean };

/** Model identity triple (protocol §2). */
interface AgentModelId {
	provider: string;
	id: string;
	name: string;
}

/** One selectable model (protocol §2 AgentState). */
interface AgentModelRef extends AgentModelId {
	/** Efforts the model declares; empty for non-reasoning models. */
	thinkingEfforts: string[];
	/** Effort applied when the model is selected; null means the SDK default. */
	defaultThinkingLevel: string | null;
}

/** One chat-section model role and its current assignment (protocol §2). */
interface AgentRoleState {
	role: string;
	name: string;
	/** Resolved assignment; `null` when neither configured nor auto-inferred. */
	model: AgentModelId | null;
	/** `model` came from fallback — the role has no configured value (0.10.0+). */
	auto: boolean;
}

/** `get-state` payload (protocol §2 AgentState). */
interface AgentState {
	sessionName: string;
	cwd: string;
	model: AgentModelId | null;
	thinkingLevel: string | null;
	thinkingLevels: string[];
	models: AgentModelRef[];
	roles: AgentRoleState[];
	/** Opt-in to advertised maximum context windows. */
	extendedContext: boolean;
	/** SDK goal-mode state, cloned for the wire; null when no goal is armed. */
	goal: GoalModeState | null;
	/** Loop controller status; null when the loop is disabled. */
	loop: LoopStatus | null;
	/** Tool names currently exposed at the top level (0.9.0; sorted). */
	tools: string[];
	/** Armed one-shot model hand-off (0.9.0+); null when disarmed. */
	prewalk: AgentModelId & { thinkingLevel: string | null } | null;
	/** Plan-mode state (0.9.0+); null when the SDK reports none. */
	plan: { enabled: boolean; planFilePath: string; workflow: string | null } | null;
	/** Second-model advisor toggle (0.9.0+). */
	advisor: { enabled: boolean };
	/** Process-wide pause gate, this child (0.9.0+). */
	paused: boolean;
	/** Applied service tiers, family → tier (0.9.0+). */
	tiers: Record<string, string>;
}

/** `mcp-config-writer` module surface (config file read-modify-write, protocol §2 `mcp-*`). */
type McpConfigWriter = typeof import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
/** `mcp-client` module surface (temporary test connections, protocol §2 `mcp-test`). */
type McpClient = typeof import("@oh-my-pi/pi-coding-agent/mcp/client");
/** The `MCPManager` class: the live session manager singleton plus test connections. */
type McpManagerClass = typeof MCPManager;
/** User/project `mcp.json` path resolution (pi-utils, same resolver the SDK discovery uses). */
type GetMCPConfigPathFn = typeof import("@oh-my-pi/pi-utils").getMCPConfigPath;

/**
 * SDK functions the command surface needs, loaded lazily in `run()` after the
 * config boundary (with the rest of the SDK) so native-binding failures still
 * surface as JSONL error frames.
 */
interface CommandDeps {
	/** Fork from the persisted transcript without switching the source session identity. */
	sessionManagerClass: typeof SessionManager;
	parseThinkingLevel: typeof ParseThinkingLevel;
	modelRoles: typeof ModelRoles;
	roleModels: typeof RoleModels;
	computeSessionContextBreakdown: typeof computeSessionContextBreakdown;
	/** Valid one-off compact mode names (contract §1). */
	compactModes: typeof COMPACT_MODES;
	/** Settings `cycleOrder` descriptor (`cycle-model` `roleCycle`, 0.10.0+). */
	cfgCycleOrder: typeof CfgCycleOrder;
	evaluateLoopCondition: typeof evaluateLoopCondition;
	/** MCP management surface (protocol §2 `mcp-*`): config writer, test client, live manager class. */
	mcp: {
		config: McpConfigWriter;
		client: McpClient;
		manager: McpManagerClass;
		configPath: GetMCPConfigPathFn;
	};
	/** Typed `extendedContext` setting descriptor (SDK ≥ v18 descriptor registry; string keys are gone). */
	cfgExtendedContext: typeof CfgExtendedContext;
	/** CLI model/role-pattern resolution surface (`resolveCliModel`, role aliases, match preferences). */
	modelResolver: typeof ModelResolver;
	/** Service-tier family/tier validation helpers (protocol §2 `tier`). */
	serviceTier: typeof ServiceTierConfig;
	/** Provider → service-tier family classifier (dependency-free pi-ai types module). */
	serviceTierFamily: typeof ServiceTierFamilyFn;
	/** Allowlisted settings projection + override application (`get-settings`/`set-setting`). */
	settingsGateway: typeof SettingsGateway;
	/** Advisor config discovery (WATCHDOG.yml walk, protocol §2 `advisor`). */
	advisor: typeof AdvisorDiscovery;
	/** Process-wide pause gate (`pause` cmd, AgentState.paused; one session per process). */
	pauseGate: AgentPauseGate;
	/** Background dispatches (`compact`) can only log their failures. */
	log: Logger;
	/** Fleet dispatch failures must wake the controlling superagent, not just toast a guest. */
	emitFleetEvent?: (event: { kind: "operation_failed"; operationId: string; error: string }) => void;
}

/**
 * Levels offered when the current model declares no controllable effort surface
 * (`Model.thinking` unset — non-reasoning or router-selected models).
 */
const FALLBACK_THINKING_LEVELS: readonly string[] = ["off", "low", "medium", "high"];

/** `get-state`: session identity plus the model/thinking surface for the web UI. */
function agentState(session: AgentSession, deps: CommandDeps, loop: LoopStatus | null): AgentState {
	const model = session.model;
	const efforts = session.getAvailableThinkingLevels();
	const available = session.getAvailableModels();
	return {
		sessionName: session.sessionName ?? "",
		cwd: session.sessionManager.getCwd(),
		model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null,
		thinkingLevel: session.thinkingLevel ?? null,
		// `off` is always selectable; the rest are the model's declared efforts
		// (`Model.thinking.efforts`, already filtered to the reasoning-capable set).
		thinkingLevels: efforts.length > 0 ? ["off", ...efforts] : [...FALLBACK_THINKING_LEVELS],
		models: available.map(entry => ({
			provider: entry.provider,
			id: entry.id,
			name: entry.name ?? entry.id,
			// Static catalog metadata, so the web model picker can offer a thinking
			// level for any candidate model, not just the active one.
			thinkingEfforts: entry.reasoning ? [...(entry.thinking?.efforts ?? [])] : [],
			defaultThinkingLevel: entry.thinking?.defaultLevel ?? null,
		})),
		roles: agentRoles(session, available, deps),
		extendedContext: deps.cfgExtendedContext.get(session.settings),
		goal: goalState(session),
		loop,
		// The session's effective callable surface — what a `tools` whitelist
		// (start.tools) actually produced, not a config echo.
		tools: [...session.getActiveToolNames()].sort(),
		prewalk: prewalkState(session),
		plan: planState(session),
		advisor: { enabled: session.isAdvisorEnabled() },
		paused: deps.pauseGate.paused,
		tiers: appliedTiers(session),
	};
}

/** The SDK's goal-mode state, deep-cloned so wire JSON cannot alias live SDK objects. */
function goalState(session: AgentSession): GoalModeState | null {
	const state = session.getGoalModeState();
	return state ? (JSON.parse(JSON.stringify(state)) as GoalModeState) : null;
}

/** Armed prewalk hand-off as wire identity; null when disarmed. */
function prewalkState(session: AgentSession): AgentState["prewalk"] {
	const state = session.getPrewalkState();
	if (!state) return null;
	return {
		provider: state.target.provider,
		id: state.target.id,
		name: state.target.name ?? state.target.id,
		thinkingLevel: state.thinkingLevel ?? null,
	};
}

/** Plan-mode state projection; null when the SDK reports none. */
function planState(session: AgentSession): AgentState["plan"] {
	const state = session.getPlanModeState();
	if (!state) return null;
	return { enabled: state.enabled, planFilePath: state.planFilePath, workflow: state.workflow ?? null };
}

/** Applied service tiers (family → tier), omitting families with no tier set. */
function appliedTiers(session: AgentSession): Record<string, string> {
	const tiers: Record<string, string> = {};
	for (const [family, tier] of Object.entries(session.serviceTierByFamily)) {
		if (tier !== undefined) tiers[family] = tier;
	}
	return tiers;
}

/**
 * Resolve a `/prewalk`-style model/role selector (`@smol`, `@default`, fuzzy
 * ids, `provider/id`) the way the SDK's own prewalk settings watcher and the
 * TUI do: over the session's model registry, scoped to the session's
 * `--models` list when one exists. Throws stable caller-readable errors.
 */
function resolveModelSelector(
	session: AgentSession,
	pattern: string,
	deps: CommandDeps,
): { model: Model; thinkingLevel: ModelResolver.ResolveCliModelResult["thinkingLevel"] } {
	const scoped = session.scopedModels.map(entry => entry.model);
	const resolved = deps.modelResolver.resolveCliModel({
		cliModel: pattern,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		preferences: deps.modelResolver.getModelMatchPreferences(session.settings),
	});
	if (!resolved.model || resolved.error) {
		throw new Error(resolved.error ?? `model "${pattern}" not found`);
	}
	if (!session.modelRegistry.hasConfiguredAuth(resolved.model)) {
		throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
	}
	return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

/**
 * Chat-section roles with their resolved assignment. Kind roles (image/web/
 * speech/…) select non-chat models the web picker never lists, so they stay
 * host-only. The default role resolves to the active model when unconfigured.
 * Exported for tests (same as `executeCommand`).
 */
export function agentRoles(session: AgentSession, available: Model[], deps: CommandDeps): AgentRoleState[] {
	const roles: AgentRoleState[] = [];
	const matchPreferences = deps.modelResolver.getModelMatchPreferences(session.settings);
	for (const role of deps.modelRoles.getKnownRoleIds(session.settings)) {
		const info = deps.modelRoles.getRoleInfo(role, session.settings);
		if (info.section !== "chat") continue;
		const configured = session.settings.getModelRole(role);
		const resolved = deps.roleModels.resolveRoleModelFull(session.settings, role, available, session.model ?? undefined);
		let model = resolved.model ?? null;
		// No configured value but a resolved model ⇒ auto-selection (TUI parity):
		// `default` falls back to the active session model, the rest fall through
		// to the priority/auto-selection expansion below.
		let auto = configured === undefined && model !== null;
		if (!model && configured === undefined && role !== "default") {
			// Unconfigured role (0.10.0): mirror the TUI model hub's auto-selection —
			// expand the legacy `pi/<role>` alias over the accepts-filtered pool,
			// which walks the role's fallback chain (configured-role fallbacks →
			// default inheritance → priority lists) instead of reporting null.
			const inferred = deps.modelResolver.resolveModelRoleValue(
				`${deps.modelRoles.LEGACY_MODEL_ROLE_ALIAS_PREFIX}${role}`,
				available.filter(info.accepts),
				{ settings: session.settings, matchPreferences },
			);
			if (inferred.model) {
				model = inferred.model;
				auto = true;
			}
		}
		roles.push({
			role,
			name: info.name || role,
			model: model
				? { provider: model.provider, id: model.id, name: model.name ?? model.id }
				: null,
			auto,
		});
	}
	return roles;
}

/** Validated `set-model` role; omitted/blank means `"default"`. */
function parseRole(role: string | undefined): string {
	if (role === undefined) return "default";
	const trimmed = role.trim();
	if (trimmed === "" || trimmed.length > 64) throw new Error(`invalid model role: ${JSON.stringify(role)}`);
	return trimmed;
}

/**
 * `set-model` `clearRole` (0.10.0+): drop the role's persisted assignment so
 * auto-selection applies (TUI unassign parity). The value is cleared on the
 * layer that supplies it (project shadows global); a `default` clear then
 * mirrors the TUI by switching the live session to any newly exposed
 * persisted value — without writing settings back. Returns whether the
 * active model changed.
 */
async function clearModelRole(session: AgentSession, role: string, deps: CommandDeps): Promise<boolean> {
	const settings = session.settings;
	// Effective value before the clear; a default clear that exposes the same
	// value must not churn the live session (TUI parity).
	const previous = role === "default" ? settings.getModelRole("default") : undefined;
	if (settings.getProjectModelRole(role) !== undefined) settings.clearProjectModelRole(role);
	else settings.setModelRole(role, undefined);
	if (role !== "default") return false;
	// Clearing the default can expose a persisted project/global value that now
	// rules; resolve it and move the active model without persisting anything.
	const fallbackValue = settings.getModelRole("default");
	const provenance = settings.getModelRoleProvenance("default");
	if (!fallbackValue || fallbackValue === previous) return false;
	if (provenance !== "project" && provenance !== "global") return false;
	const scoped = session.scopedModels.map(entry => entry.model);
	const available = scoped.length > 0 ? scoped : session.getAvailableModels();
	const resolved = deps.modelResolver.resolveModelRoleValue(fallbackValue, available, { settings });
	if (!resolved.model) return false;
	const level = resolved.explicitThinkingLevel
		? deps.parseThinkingLevel(String(resolved.thinkingLevel ?? ""))
		: undefined;
	const { switched } = await session.setModel(resolved.model, "default", { persist: false });
	if (switched && level !== undefined) session.setThinkingLevel(level);
	return switched;
}

/** Preview cap per `get-tree` node, in characters after whitespace folding. */
const TREE_PREVIEW_CHARS = 120;
/** Hard node cap per `get-tree` payload; the oldest DFS subtrees are dropped. */
const TREE_NODE_CAP = 4000;

/**
 * Entry kinds the collab wire carries; everything else (`custom` HUD notes,
 * `model_usage`, …) is pruned from the tree payload — the web never sees those
 * types, and pruning them is what forces the re-homing of `parentId` below.
 */
const WIRED_ENTRY_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

/** One `get-tree` node: structure plus a one-line preview, never a message body (protocol §2 SessionTree). */
interface TreeWireNode {
	id: string;
	/**
	 * Nearest KEPT ancestor — non-wire entries (`custom` HUD notes, `model_usage`,
	 * …) are pruned, and their children are re-homed so the shape the web renders
	 * matches the real topology.
	 */
	parentId: string | null;
	type: string;
	/** `message` entries only. */
	role?: string;
	/** Host-injected user prompt (not a guest/authored turn). */
	synthetic?: true;
	/** `toolResult` messages only. */
	toolName?: string;
	/** `custom_message` entries only. */
	customType?: string;
	preview: string;
	timestamp: string;
	/** Session label attached by the SDK (e.g. branch checkpoints). */
	label?: string;
	/** On the active leaf path (root → leaf). */
	branch?: true;
	/** The current leaf. */
	leaf?: true;
	children: TreeWireNode[];
}

/** `get-tree` payload (protocol §2 SessionTree). */
interface SessionTreePayload {
	leafId: string | null;
	/** `true` when {@link TREE_NODE_CAP} dropped parts of the tree. */
	truncated: boolean;
	nodes: TreeWireNode[];
}

/** One-line text for a tree node; identity, not content — previews only. */
function treePreview(entry: StoredSessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "toolResult") return `[${message.toolName ?? "tool"} result]`;
			// Conversation turns only; other AgentMessage kinds (bash execution, …)
			// carry no renderable text block.
			if (message.role !== "user" && message.role !== "assistant") return "";
			let text = "";
			if (typeof message.content === "string") text = message.content;
			else {
				for (const block of message.content) {
					if (block.type === "text" && "text" in block) {
						text = block.text;
						break;
					}
				}
			}
			return text.replace(/\s+/g, " ").trim().slice(0, TREE_PREVIEW_CHARS);
		}
		case "custom_message": {
			const text =
				typeof entry.content === "string"
					? entry.content
					: (entry.content.find(block => block.type === "text")?.text ?? "");
			return text.replace(/\s+/g, " ").trim().slice(0, TREE_PREVIEW_CHARS);
		}
		case "compaction":
			return `compacted (${entry.tokensBefore} tokens)`;
		case "branch_summary":
			return entry.summary.replace(/\s+/g, " ").trim().slice(0, TREE_PREVIEW_CHARS);
		case "model_change":
			return `model → ${entry.model}`;
		case "thinking_level_change":
			return `thinking → ${entry.thinkingLevel ?? "off"}`;
		default:
			return "";
	}
}

/**
 * Serialize the session tree for the web `/tree` picker: every stored entry
 * kind the wire knows, structure intact, bodies reduced to previews. The node
 * cap keeps a pathological transcript from producing a multi-megabyte cmd
 * reply; DFS order is parents-before-children with timestamp-sorted siblings,
 * so dropping from the front sheds the oldest turns.
 */
function sessionTree(session: AgentSession): SessionTreePayload {
	const manager = session.sessionManager;
	const leafId = manager.getLeafId();
	const branchIds = new Set(manager.getBranch().map(entry => entry.id));

	const flat: SessionTreeNode[] = [];
	const walk = (node: SessionTreeNode): void => {
		flat.push(node);
		for (const child of node.children) walk(child);
	};
	for (const root of manager.getTree()) walk(root);

	const kept = new Set<string>();
	for (let i = flat.length - 1; i >= 0 && kept.size < TREE_NODE_CAP; i--) {
		const entry = flat[i]!.entry;
		if (WIRED_ENTRY_TYPES[entry.type]) kept.add(entry.id);
	}
	const byId = new Map(flat.map(node => [node.entry.id, node]));

	const nodes = new Map<string, TreeWireNode>();
	for (const node of flat) {
		const entry = node.entry;
		if (!kept.has(entry.id)) continue;
		// Walk literal parents up to the nearest kept ancestor.
		let effective = entry.parentId;
		while (effective !== null && !kept.has(effective)) effective = byId.get(effective)?.entry.parentId ?? null;
		const message = entry.type === "message" ? entry.message : null;
		nodes.set(entry.id, {
			id: entry.id,
			parentId: effective,
			type: entry.type,
			...(message
				? {
						role: message.role,
						...(message.role === "user" && message.synthetic === true ? { synthetic: true as const } : {}),
						...(message.role === "toolResult" ? { toolName: message.toolName } : {}),
					}
				: {}),
			...(entry.type === "custom_message" ? { customType: entry.customType } : {}),
			preview: treePreview(entry),
			timestamp: entry.timestamp,
			...(node.label ? { label: node.label } : {}),
			...(branchIds.has(entry.id) ? { branch: true as const } : {}),
			...(entry.id === leafId ? { leaf: true as const } : {}),
			children: [],
		});
	}

	const roots: TreeWireNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentId ? nodes.get(node.parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return { leafId, truncated: flat.reduce((total, node) => total + (WIRED_ENTRY_TYPES[node.entry.type] ? 1 : 0), 0) > TREE_NODE_CAP, nodes: roots };
}

/** Hard cap on one hub upload's decoded bytes (mirrors the hub's HTTP body cap, protocol §2). */
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
/** Tmp-file prefix for hub uploads; also the sweep selector (exported for tests). */
export const UPLOAD_PREFIX = "omp-hub-upload-";
/** Uploads older than this are pruned opportunistically; OS tmp cleaners are the backstop. */
const UPLOAD_SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hub upload write path (protocol §2 `upload-file`; exported test seam): write one
 * uploaded attachment under the machine's temp directory and return the absolute path
 * the model can target with `read`. The client-supplied name is reduced to a bare
 * filename before it ever reaches the filesystem, and the file is owner-only.
 */
export async function writeHubUpload(rawName: string | undefined, dataB64: string | undefined): Promise<{ path: string; bytes: number }> {
	if (!dataB64) throw new Error("upload-file requires dataB64");
	const bytes = Buffer.from(dataB64, "base64");
	if (bytes.byteLength === 0) throw new Error("invalid upload encoding");
	if (bytes.byteLength > UPLOAD_MAX_BYTES) throw new Error("file too large");
	const safeName = (rawName ?? "").replace(/^.*[\\/]/, "").replace(/[\x00-\x1F\x7F]/g, "").trim() || "file";
	const name = safeName.length > 128 ? `${safeName.slice(0, 100)}…${safeName.slice(-24)}` : safeName;
	const target = join(tmpdir(), `${UPLOAD_PREFIX}${randomBytes(6).toString("hex")}-${name}`);
	await writeFile(target, bytes, { mode: 0o600 });
	void sweepOldUploads();
	return { path: target, bytes: bytes.byteLength };
}

/** Stale-upload prune (exported test seam): removes `omp-hub-upload-*` files older than a week. */
export async function sweepOldUploads(): Promise<void> {
	try {
		const dir = tmpdir();
		const now = Date.now();
		for (const entry of await readdir(dir)) {
			if (!entry.startsWith(UPLOAD_PREFIX)) continue;
			const full = join(dir, entry);
			const info = await stat(full).catch(() => undefined);
			if (info?.isFile() && now - info.mtimeMs > UPLOAD_SWEEP_AGE_MS) {
				await rm(full, { force: true }).catch(() => {});
			}
		}
	} catch {
		// the sweep is opportunistic; tmp cleaner policies own the real reclamation
	}
}

/**
 * First text of a prompt payload: a bare string, or the first text block.
 * Covers collab prompt entries (`custom_message` content) and user messages
 * alike; image-only payloads yield `undefined` (exported for tests).
 */
export function firstText(content: string | ReadonlyArray<{ type: string; text?: string }> | undefined): string | undefined {
	if (typeof content === "string") return content;
	return content?.find(part => part.type === "text")?.text;
}

/**
 * First user-authored text in the conversation: a user-role message, or the
 * first text-bearing custom message. Collab prompts enter sessions as
 * `custom` messages (`collab-prompt`), never as user-role messages, so a
 * collab-only conversation has no `user` message to find (exported for tests).
 */
export function firstUserText(
	messages: ReadonlyArray<{ role: string; content?: string | ReadonlyArray<{ type: string; text?: string }> }>,
): string | undefined {
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "custom") continue;
		const text = firstText(message.content);
		if (text?.trim()) return text;
	}
	return undefined;
}

/** Catalog cap per server on `mcp-list`/`mcp-test` payloads; schemas stay host-side. */
const MCP_CATALOG_CAP = 50;
/** Description cap per cataloged tool, in characters. */
const MCP_DESCRIPTION_CAP = 200;

/** One cataloged tool/resource/prompt on a `mcp-list`/`mcp-test` payload. */
interface McpCatalogEntry {
	name: string;
	description?: string;
}

/** MCP config scope of one server entry. */
type McpScope = "user" | "project";

/** Validated `mcp-add`/`mcp-remove` scope; omitted/blank means `"project"`. */
function parseMcpScope(raw: string | undefined): McpScope {
	if (raw === undefined || raw.trim() === "") return "project";
	if (raw === "project" || raw === "user") return raw;
	throw new Error(`invalid scope: ${raw} (use project or user)`);
}

/**
 * One-line location for a listing row (TUI `handleListCommand` parity): the
 * stdio command, or the remote URL stripped of query string and userinfo so
 * API keys carried in either never reach the hub or the browser.
 */
function mcpServerLocation(config: MCPServerConfig): string | null {
	if (config.type === "http" || config.type === "sse") return redactedUrlLocation(config.url);
	return config.command;
}

/** Remote URL stripped to origin + path; null when unparseable or empty. */
function redactedUrlLocation(raw: string): string | null {
	if (!raw) return null;
	try {
		const parsed = new URL(raw);
		const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
		return `${parsed.origin}${path}`;
	} catch {
		return null;
	}
}

/** Trim one catalog description to the wire cap. */
function mcpCatalogEntry(name: string, description: string | undefined): McpCatalogEntry {
	const clean = description?.trim();
	if (!clean) return { name };
	return {
		name,
		description: clean.length > MCP_DESCRIPTION_CAP ? `${clean.slice(0, MCP_DESCRIPTION_CAP)}…` : clean,
	};
}

/** Bounded `{name, description}` catalog from full MCP tool/resource/prompt objects. */
function mcpCatalog(entries: ReadonlyArray<{ name: string; description?: string }>): McpCatalogEntry[] {
	return entries.slice(0, MCP_CATALOG_CAP).map(entry => mcpCatalogEntry(entry.name, entry.description));
}

/** `mcp-add` stdio config from frame fields. */
function mcpStdioConfig(command: string, args: string[] | undefined): MCPStdioServerConfig {
	return {
		type: "stdio",
		command,
		...(args !== undefined && args.length > 0 ? { args: [...args] } : {}),
	};
}

/** `mcp-add` remote config: normalized URL plus the optional bearer header. */
function mcpRemoteConfig(transport: "http" | "sse", rawUrl: string, token: string | undefined): MCPHttpServerConfig | MCPSseServerConfig {
	const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
	if (transport === "sse") {
		return { type: "sse", url: normalizedUrl, ...(token !== undefined ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
	}
	return { type: "http", url: normalizedUrl, ...(token !== undefined ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
}

/** `mcp-add` config from frame fields: stdio (`command`+`args`) or remote (`url`+`transport`, `token` → header). */
function buildMcpServerConfig(frame: CommandFrame): MCPServerConfig {
	const name = typeof frame.name === "string" ? frame.name.trim() : "";
	if (!name) throw new Error("mcp-add requires a server name");
	const hasCommand = typeof frame.command === "string" && frame.command.trim() !== "";
	const hasUrl = typeof frame.url === "string" && frame.url.trim() !== "";
	if (hasCommand && hasUrl) throw new Error("use either command or url, not both");
	if (!hasCommand && !hasUrl) throw new Error("mcp-add requires command or url");
	let token: string | undefined;
	if (frame.token !== undefined) {
		if (typeof frame.token !== "string" || frame.token.trim() === "") throw new Error("token must be a non-empty string");
		token = frame.token;
	}
	if (token !== undefined && !hasUrl) throw new Error("token requires url (http/sse transport)");
	const args = frame.args === undefined ? undefined : mcpStringArgs(frame.args);

	if (hasCommand) return mcpStdioConfig(frame.command!.trim(), args);
	const transport = frame.transport === undefined || frame.transport === "" ? "http" : frame.transport;
	if (transport !== "http" && transport !== "sse") throw new Error(`invalid transport: ${transport} (use http or sse)`);
	return mcpRemoteConfig(transport, frame.url!.trim(), token);
}

/** Validated `mcp-add` args array; undefined stays undefined. */
function mcpStringArgs(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw) || raw.some(arg => typeof arg !== "string")) {
		throw new Error("args must be an array of strings");
	}
	return raw as string[];
}

/**
 * One `mcp-list` row: config truth (TUI `handleListCommand` fields, redacted)
 * joined with the live session manager's view (health, implementation,
 * instructions, bounded catalogs) for enabled, non-shadowed entries — the same
 * join the TUI `/extensions` dashboard draws, minus schemas and env values.
 * Env/header/token values never cross the wire; `envCount` and the redacted
 * location are the only echoes.
 */
function mcpListServer(
	name: string,
	config: MCPServerConfig,
	scope: McpScope,
	shadowed: boolean,
	disabledList: ReadonlySet<string>,
	manager: MCPManager | undefined,
): Record<string, unknown> {
	const enabled = config.enabled !== false && !disabledList.has(name);
	const row: Record<string, unknown> = {
		name,
		scope,
		type: config.type ?? "stdio",
		enabled,
		location: mcpServerLocation(config),
		envCount: "env" in config && config.env ? Object.keys(config.env).length : 0,
	};
	if (shadowed) row.shadowed = true;
	if (config.type === "stdio" && config.args && config.args.length > 0) row.args = [...config.args];
	// Shadowed same-name configs share the name with the winner: joining by
	// name would steal the live connection's health/catalog for a dead row
	// (TUI `snapshotMcpRuntime` shadowed guard parity).
	if (shadowed || !enabled || manager === undefined) return row;

	const health = manager.getConnectionStatus(name);
	row.health = health;
	if (health !== "connected") return row;
	const connection = manager.getConnection(name);
	if (!connection) return row;
	const info = connection.serverInfo;
	if (info?.name) {
		row.implementationName = info.name;
		if (info.version) row.implementationVersion = info.version;
	}
	if (connection.instructions) row.instructions = connection.instructions;
	const connectionTools = connection.tools ?? [];
	const tools =
		connectionTools.length > 0 ? connectionTools : manager.getTools().filter(tool => tool.mcpServerName === name);
	row.toolsCount = tools.length;
	row.tools = mcpCatalog(tools.map(tool => ({ name: tool.name, description: tool.description })));
	const resources = manager.getServerResources(name);
	if (resources) row.resourcesCount = resources.resources.length + resources.templates.length;
	const prompts = manager.getServerPrompts(name);
	if (prompts) row.promptsCount = prompts.length;
	return row;
}

/**
 * Live session manager accessor. The SDK pins each top-level session's manager
 * into the process-global slot (`MCPManager.setInstance`), and a session host
 * child hosts exactly one session — the singleton IS this session's manager.
 * A missing or stale instance (older agent SDK, disposed session) just means
 * no live section on the rows.
 */
function liveMcpManager(deps: CommandDeps): MCPManager | undefined {
	try {
		return deps.mcp.manager.instance();
	} catch {
		return undefined;
	}
}

/** `mcp-list` payload: user rows first, then project rows (TUI listing order); project shadows user. */
async function mcpListPayload(cwd: string, deps: CommandDeps): Promise<{ servers: Array<Record<string, unknown>> }> {
	const userPath = deps.mcp.configPath("user", cwd);
	const projectPath = deps.mcp.configPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([
		deps.mcp.config.readMCPConfigFile(userPath),
		deps.mcp.config.readMCPConfigFile(projectPath),
	]);
	const disabledList = new Set(await deps.mcp.config.readDisabledServers(userPath));
	// The loader's merge order: project entries shadow same-name user entries.
	const projectNames = new Set(Object.keys(projectConfig.mcpServers ?? {}));
	const manager = liveMcpManager(deps);

	const servers: Array<Record<string, unknown>> = [];
	for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
		servers.push(mcpListServer(name, config, "user", projectNames.has(name), disabledList, manager));
	}
	for (const [name, config] of Object.entries(projectConfig.mcpServers ?? {})) {
		servers.push(mcpListServer(name, config, "project", false, disabledList, manager));
	}
	return { servers };
}

/**
 * `mcp-test` (TUI ACP `handleTestCommand` parity): one temporary connection to
 * a configured, enabled server — the live session manager is not touched.
 * OAuth-backed servers get the session's auth storage so saved credentials
 * refresh exactly as they do at session start. The connection (and any stdio
 * subprocess) is always torn down before this returns.
 */
async function mcpTestPayload(
	session: AgentSession,
	frame: CommandFrame,
	deps: CommandDeps,
): Promise<{ name: string; count: number; tools: McpCatalogEntry[] }> {
	const name = typeof frame.name === "string" ? frame.name.trim() : "";
	if (!name) throw new Error("mcp-test requires a server name");
	const cwd = session.sessionManager.getCwd();
	const userPath = deps.mcp.configPath("user", cwd);
	const projectPath = deps.mcp.configPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([
		deps.mcp.config.readMCPConfigFile(userPath),
		deps.mcp.config.readMCPConfigFile(projectPath),
	]);
	const disabledList = new Set(await deps.mcp.config.readDisabledServers(userPath));
	// Same candidate set as the loader: enabled, non-shadowed entries, project first.
	const config = projectConfig.mcpServers?.[name] ?? userConfig.mcpServers?.[name];
	if (!config || config.enabled === false || disabledList.has(name)) {
		throw new Error(`server "${name}" not found or disabled (see mcp-list)`);
	}

	let connection: MCPServerConnection | undefined;
	try {
		const manager = new deps.mcp.manager(cwd, null);
		manager.setAuthStorage(session.modelRegistry.authStorage);
		const resolved = await manager.prepareConfig(config);
		connection = await deps.mcp.client.connectToServer(name, resolved);
		const tools = await deps.mcp.client.listTools(connection);
		return { name, count: tools.length, tools: mcpCatalog(tools) };
	} finally {
		if (connection) {
			try {
				await deps.mcp.client.disconnectServer(connection);
			} catch (err) {
				deps.log.warn(`mcp-test disconnect failed for "${name}": ${errorMessage(err)}`);
			}
		}
	}
}

/** Run one session command; a throw becomes `{ok:false,error}` on the wire (§4). */
export async function executeCommand(session: AgentSession, frame: CommandFrame, deps: CommandDeps, loop: SessionLoop, ui?: FleetInputBridge): Promise<unknown> {
	switch (frame.cmd) {
		case "get-state":
			return agentState(session, deps, loop.status());
		case "get-context":
			// The SDK's own estimated split, without the snapcompact planner: it
			// renders images for a savings estimate the UI never shows. Numbers and
			// labels only — no prompt text and no model object cross this boundary.
			return sessionContextPayload(deps.computeSessionContextBreakdown(session));
		case "set-model": {
			// 0.10.0 `clearRole`: unassign the role (auto-selection applies) instead
			// of switching; `provider`/`modelId` are ignored on this path.
			if (frame.clearRole === true) {
				const role = parseRole(frame.role);
				const switched = await clearModelRole(session, role, deps);
				return { switched, role, thinkingLevel: session.thinkingLevel ?? null };
			}
			const { provider, modelId } = frame;
			if (!provider || !modelId) throw new Error("set-model requires provider and modelId");
			const role = parseRole(frame.role);
			// Validate an optional thinking level before mutating anything so a bad
			// level cannot leave a half-applied switch behind.
			const level = frame.level === undefined ? undefined : deps.parseThinkingLevel(frame.level);
			if (level === undefined && frame.level !== undefined) {
				throw new Error(`invalid thinking level: ${frame.level}`);
			}
			const model = session.modelRegistry.find(provider, modelId);
			if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
			// A non-default role is a persistent assignment (omp `/model @role`):
			// it switches the active model now AND survives the session unless
			// `persist: false`. The plain switch keeps its session-scope behavior.
			const { switched } = await session.setModel(
				model,
				role,
				role === "default" || frame.persist === false ? undefined : { persist: true },
			);
			// Deliberately after the switch: setModel re-resolves thinking to the
			// target model's default, so an explicit level must come second to win.
			if (level !== undefined) session.setThinkingLevel(level);
			return { switched, role, thinkingLevel: session.thinkingLevel ?? null };
		}
		case "set-thinking": {
			const level = deps.parseThinkingLevel(frame.level);
			if (level === undefined) throw new Error(`invalid thinking level: ${String(frame.level)}`);
			session.setThinkingLevel(level);
			return { thinkingLevel: session.thinkingLevel ?? null };
		}
		case "get-tree":
			return sessionTree(session);
		case "navigate-tree": {
			const entryId = typeof frame.entryId === "string" ? frame.entryId.trim() : "";
			if (!entryId) throw new Error("navigate-tree requires entryId");
			// Rewinding onto a user message moves the leaf PAST it (text comes
			// back via editorText). A mid-run navigation aborts the in-flight
			// turn and reports `aborted` — the caller may retry once settled.
			const result = await session.navigateTree(entryId, { summarize: frame.summarize === true });
			return {
				cancelled: result.cancelled,
				aborted: result.aborted ?? false,
				editorText: result.editorText ?? null,
				leafId: session.sessionManager.getLeafId() ?? null,
			};
		}
		case "compact": {
			const instructions = typeof frame.instructions === "string" && frame.instructions.trim() ? frame.instructions : undefined;
			const mode = typeof frame.mode === "string" && frame.mode.trim() ? frame.mode.trim() : undefined;
			// Validate up front: compaction is a model call that cannot answer the
			// 15 s cmd budget, so a typo'd mode must fail here, synchronously.
			const modeDef = mode === undefined ? undefined : deps.compactModes.find(entry => entry.name === mode);
			if (mode !== undefined && !modeDef) {
				throw new Error(`unknown compact mode: ${mode} (known: ${deps.compactModes.map(entry => entry.name).join(", ")})`);
			}
			// Background dispatch (contract §1): reply immediately, errors log
			// only — progress is visible in the transcript via collab events.
			void session
				.compact(instructions, modeDef === undefined ? undefined : { mode: modeDef.name })
				.catch((err: unknown) => {
					deps.log.error(`compact failed: ${errorMessage(err)}`);
					// The dispatch is otherwise silent on the wire (the cmd already
					// answered `started`): surface the failure to attached guests
					// through the notice stream (web toasts it).
					session.emitNotice("error", `compact failed: ${errorMessage(err)}`);
				});
			return { started: true };
		}
		case "shake": {
			// TUI `/shake` parity (oh-my-pi `builtin-lifecycle`): a local, model-free
			// context diet — elide strips tool results + large blocks, images drops
			// image blocks (including old snapcompact archive frames), thinking
			// drops thinking blocks. Settles inside the cmd budget; the counts reply
			// verbatim so the caller can format its own summary.
			const mode = typeof frame.mode === "string" && frame.mode.trim() ? frame.mode.trim().toLowerCase() : "elide";
			if (mode !== "elide" && mode !== "images" && mode !== "thinking") {
				throw new Error(`unknown shake mode: ${mode} (known: elide, images, thinking)`);
			}
			return session.shake(mode);
		}
		case "handoff": {
			// TUI `/handoff` parity: summarize the session into a handoff document
			// and compact in place. A model call, so — like `compact` — caller-input
			// failures are validated here and the run dispatches in the background;
			// progress and the outcome arrive through the transcript stream.
			const instructions = typeof frame.instructions === "string" && frame.instructions.trim() ? frame.instructions : undefined;
			if (session.isStreaming) {
				throw new Error("Wait for the current response to finish or abort it before handing off.");
			}
			if (session.isGeneratingHandoff) {
				throw new Error("Handoff generation is already in progress.");
			}
			void session
				.handoff(instructions)
				.then(result => {
					// SDK contract: `null` is a genuine cancellation, not a failure —
					// mirror the TUI's "Handoff cancelled" line for attached guests.
					if (result === null) session.emitNotice("info", "handoff cancelled");
				})
				.catch((err: unknown) => {
					deps.log.error(`handoff failed: ${errorMessage(err)}`);
					// The cmd already answered `{started:true}`, so a failure would
					// otherwise be child-log-only: surface it to attached guests
					// through the notice stream (web toasts it).
					session.emitNotice("error", `handoff failed: ${errorMessage(err)}`);
				});
			return { started: true };
		}
		case "retry": {
			// A retry mid-stream would interleave two turns on one transcript.
			if (session.isStreaming) throw new Error("Wait for the current response to finish or abort it before retrying.");
			return { started: await session.retry() };
		}
		case "loop": {
			switch (frame.action) {
				case "enable":
					// enable validates prompt/limit/condition; a throw answers `ok:false`.
					loop.enable({ prompt: frame.prompt, limit: frame.limit, condition: frame.condition });
					break;
				case "disable":
					loop.disable();
					break;
				case "pause":
					loop.pause();
					break;
				case "resume":
					loop.resume();
					break;
				case "status":
					break;
				default:
					throw new Error(`unknown loop action: ${String(frame.action)}`);
			}
			return { loop: loop.status() };
		}
		case "goal": {
			const runtime = session.goalRuntime;
			switch (frame.action) {
				case "set":
				case "replace": {
					const objective = typeof frame.objective === "string" ? frame.objective.trim() : "";
					if (!objective) throw new Error(`goal ${frame.action} requires objective`);
					if (frame.tokenBudget !== undefined && typeof frame.tokenBudget !== "number") {
						throw new Error("goal tokenBudget must be a number");
					}
					const input = { objective, tokenBudget: frame.tokenBudget };
					if (frame.action === "set") await runtime.createGoal(input);
					else await runtime.replaceGoal(input);
					break;
				}
				case "pause":
					await runtime.pauseGoal();
					break;
				case "resume":
					await runtime.resumeGoal();
					break;
				case "drop":
					await runtime.dropGoal();
					break;
				case "budget":
					// No number clears the cap; a non-number is a caller bug.
					if (frame.tokenBudget !== undefined && typeof frame.tokenBudget !== "number") {
						throw new Error("goal budget requires a numeric tokenBudget");
					}
					await runtime.onBudgetMutated(frame.tokenBudget ?? undefined);
					break;
				default:
					throw new Error(`unknown goal action: ${String(frame.action)}`);
			}
			// SDK throws bubble (they carry good messages); reply is the post-op state.
			return { goal: goalState(session) };
		}
		case "prompt": {
			const text = typeof frame.text === "string" ? frame.text : "";
			if (text.trim() === "") throw new Error("prompt requires non-blank text");
			// A model turn can outlast the hub's 15 s command budget. Confirm
			// scheduling now; the transcript and error notice report the outcome.
			void session.prompt(text, { streamingBehavior: "followUp", throwOnDrop: true }).catch(err => {
				deps.log.error(`prompt failed: ${errorMessage(err)}`);
				session.emitNotice("error", `prompt failed: ${errorMessage(err)}`);
			});
			return { accepted: true };
		}
		case "fleet-fork-session": {
			const manager = session.sessionManager;
			const source = manager.getSessionFile();
			if (!source) throw new Error("source session is not persisted");
			const assertIdle = (): void => {
				if (session.isStreaming || session.queuedMessageCount > 0 || session.isCompacting ||
					session.isGeneratingHandoff || session.hasPostPromptWork) {
					throw new Error("session is busy; finish the current turn and queued work before forking");
				}
			};
			assertIdle();
			const sourceLeaf = manager.getLeafId();
			// The SDK writes lazily; a path on a fresh, still-in-memory session is
			// not evidence of persisted history. Never turn a missing source into
			// an empty fork or switch the original manager with session.fork().
			await manager.flush();
			assertIdle();
			if (manager.getSessionFile() !== source || manager.getLeafId() !== sourceLeaf) {
				throw new Error("source session changed while forking");
			}
			let persisted: boolean;
			try {
				persisted = (await stat(source)).isFile();
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				persisted = false;
			}
			assertIdle();
			if (!persisted) throw new Error("source session is not persisted");
			const fork = await deps.sessionManagerClass.forkFrom(source, manager.getCwd());
			const sessionFile = fork.getSessionFile();
			if (!sessionFile) throw new Error("forked session is not persisted");
			try {
				assertIdle();
				if (manager.getSessionFile() !== source || manager.getLeafId() !== sourceLeaf) {
					throw new Error("source session changed while forking");
				}
			} catch (err) {
				await fork.dropSession(sessionFile);
				throw err;
			}
			return { sessionFile };
		}
		case "fleet-get-messages":
			return pageFleetMessages(session.sessionManager, frame.cursor, frame.pageLimit);
		case "fleet-search-messages":
			return searchFleetMessages(session.sessionManager, {
				query: frame.query, from: frame.from, to: frame.to, cursor: frame.cursor, limit: frame.pageLimit,
			});
		case "fleet-get-input":
			return { pending: ui?.getPendingInput() ?? [] };
		case "fleet-answer-input": {
			if (!frame.requestId || typeof frame.answer !== "string") throw new Error("requestId and answer required");
			if (!ui?.getPendingInput().some(input => input.requestId === frame.requestId)) {
				throw new Error("input request is no longer pending");
			}
			if (!ui.answerInput(frame.requestId, frame.answer)) throw new Error("invalid input answer");
			return { ok: true };
		}
		case "fleet-message": {
			const text = typeof frame.text === "string" ? frame.text : "";
			if (!text.trim()) throw new Error("message requires non-blank text");
			if (frame.messageMode !== "start" && frame.messageMode !== "steer" && frame.messageMode !== "follow_up") throw new Error("invalid message mode");
			if (frame.messageMode === "start" && session.isStreaming) throw new Error("session is busy; choose steer or follow_up");
			const mode = frame.messageMode;
			const operationId = randomUUID();
			void (async () => {
				if (mode === "start") await session.prompt(text);
				else if (mode === "steer") await session.steer(text);
				else await session.followUp(text);
			})().catch(err => {
				deps.log.error(`fleet message failed: ${errorMessage(err)}`);
				session.emitNotice("error", `fleet message failed: ${errorMessage(err)}`);
				deps.emitFleetEvent?.({ kind: "operation_failed", operationId, error: errorMessage(err) });
			});
			return { scheduled: true, operationId };
		}
		case "fleet-interrupt": {
			if (frame.text !== undefined && (typeof frame.text !== "string" || !frame.text.trim())) throw new Error("replacement text must be non-blank");
			if (frame.clearQueue !== undefined && typeof frame.clearQueue !== "boolean") throw new Error("clearQueue must be boolean");
			if (frame.text && session.queuedMessageCount > 0 && frame.clearQueue !== true) {
				throw new Error("replacement has queued work; set clearQueue:true to discard it before interrupting");
			}
			const operationId = randomUUID();
			if (frame.clearQueue) session.clearQueue({ forInterrupt: true });
			void (async () => {
				await session.abort({ reason: "Interrupted by user" });
				if (frame.text) await session.prompt(frame.text);
			})().catch(err => {
				deps.log.error(`fleet interrupt failed: ${errorMessage(err)}`);
				session.emitNotice("error", `fleet interrupt failed: ${errorMessage(err)}`);
				deps.emitFleetEvent?.({ kind: "operation_failed", operationId, error: errorMessage(err) });
			});
			return { scheduled: true, operationId };
		}
		case "upload-file":
			return writeHubUpload(frame.name, frame.dataB64);
		case "mcp-list":
			// MCP management (protocol §2 `mcp-*`): config truth joined with the
			// session's live manager. Config edits apply to NEW sessions; the live
			// section shows what this session actually loaded at start.
			return await mcpListPayload(session.sessionManager.getCwd(), deps);
		case "mcp-add": {
			const scope = parseMcpScope(frame.scope);
			const serverName = typeof frame.name === "string" ? frame.name.trim() : "";
			const config = buildMcpServerConfig(frame);
			await deps.mcp.config.addMCPServer(deps.mcp.configPath(scope, session.sessionManager.getCwd()), serverName, config);
			return { name: serverName, scope };
		}
		case "mcp-remove": {
			const scope = parseMcpScope(frame.scope);
			const serverName = typeof frame.name === "string" ? frame.name.trim() : "";
			if (!serverName) throw new Error("mcp-remove requires a server name");
			await deps.mcp.config.removeMCPServer(deps.mcp.configPath(scope, session.sessionManager.getCwd()), serverName);
			return { name: serverName, scope };
		}
		case "mcp-set-enabled": {
			// TUI `handleEnableDisableCommand` semantics: a project entry is
			// updated in place, else a user entry, else the user-level
			// `disabledServers` list (which covers discovered servers with no
			// writable config entry). The reply names what was touched.
			const serverName = typeof frame.name === "string" ? frame.name.trim() : "";
			if (!serverName) throw new Error("mcp-set-enabled requires a server name");
			if (typeof frame.enabled !== "boolean") throw new Error("mcp-set-enabled requires a boolean enabled");
			const cwd = session.sessionManager.getCwd();
			const userPath = deps.mcp.configPath("user", cwd);
			const projectPath = deps.mcp.configPath("project", cwd);
			const [userConfig, projectConfig] = await Promise.all([
				deps.mcp.config.readMCPConfigFile(userPath),
				deps.mcp.config.readMCPConfigFile(projectPath),
			]);
			const projectEntry = projectConfig.mcpServers?.[serverName];
			if (projectEntry) {
				await deps.mcp.config.updateMCPServer(projectPath, serverName, { ...projectEntry, enabled: frame.enabled });
				return { name: serverName, enabled: frame.enabled, where: "project" };
			}
			const userEntry = userConfig.mcpServers?.[serverName];
			if (userEntry) {
				await deps.mcp.config.updateMCPServer(userPath, serverName, { ...userEntry, enabled: frame.enabled });
				return { name: serverName, enabled: frame.enabled, where: "user" };
			}
			const disabledList = await deps.mcp.config.readDisabledServers(userPath);
			if (!frame.enabled || disabledList.includes(serverName)) {
				await deps.mcp.config.setServerDisabled(userPath, serverName, !frame.enabled);
				return { name: serverName, enabled: frame.enabled, where: "disabled-list" };
			}
			throw new Error(`server "${serverName}" not found in user or project config`);
		}
		case "mcp-test":
			return await mcpTestPayload(session, frame, deps);
		case "prewalk": {
			// TUI `/prewalk` parity: arm a one-shot hand-off, or restart (restore
			// the pre-prewalk model and re-arm). `armed: false` is the SDK's own
			// no-op answer (target equals the active model and level). Bare
			// (no action) is a state read, like `plan`/`advisor`/`tier`.
			const action = frame.action ?? "state";
			let level: ConfiguredThinkingLevel | undefined;
			if (frame.level !== undefined) {
				level = deps.parseThinkingLevel(frame.level);
				if (level === undefined) throw new Error(`invalid thinking level: ${frame.level}`);
			}
			const pattern =
				typeof frame.target === "string" && frame.target.trim() ? frame.target.trim() : deps.modelResolver.DEFAULT_PREWALK_TARGET;
			switch (action) {
				case "arm": {
					const target = resolveModelSelector(session, pattern, deps);
					session.armPrewalk(target.model, level ?? target.thinkingLevel);
					return { armed: session.getPrewalkState() !== undefined, prewalk: prewalkState(session) };
				}
				case "restart": {
					const source = resolveModelSelector(session, "@default", deps);
					const target = resolveModelSelector(session, pattern, deps);
					const result = await session.restartPrewalk(
						source.model,
						source.thinkingLevel,
						target.model,
						level ?? target.thinkingLevel,
					);
					return { result, prewalk: prewalkState(session) };
				}
				case "state":
					return { prewalk: prewalkState(session) };
				default:
					throw new Error(`unknown prewalk action: ${String(action)}`);
			}
		}
		case "plan": {
			// TUI `/plan` parity: read-only plan mode from the next prompt; the
			// SDK default reference path applies when the caller omits one.
			const action = frame.action ?? "status";
			switch (action) {
				case "enable": {
					let planFilePath = session.getPlanReferencePath();
					if (frame.planFilePath !== undefined) {
						if (typeof frame.planFilePath !== "string" || !frame.planFilePath.trim()) {
							throw new Error("plan planFilePath must be a non-empty string");
						}
						planFilePath = frame.planFilePath.trim();
					}
					session.setPlanModeState({ enabled: true, planFilePath });
					break;
				}
				case "disable":
					session.setPlanModeState(undefined);
					break;
				case "status":
					break;
				default:
					throw new Error(`unknown plan action: ${String(action)}`);
			}
			return { plan: planState(session) };
		}
		case "advisor": {
			// TUI `/advisor on|off` parity. The session discovered the WATCHDOG.yml
			// roster at construction; enabling with an empty roster is a caller
			// bug, refused with a stable error.
			const advisorNames = (): string[] => session.getAdvisorStats().advisors.map(entry => entry.name);
			const action = frame.action ?? "status";
			switch (action) {
				case "enable": {
					// Explicit discovery check (protocol: no configs → ok:false) — the
					// session's own legacy fallback would silently mint a "default"
					// advisor when nothing was discovered at construction.
					const discovered = await deps.advisor.discoverAdvisorConfigs(session.sessionManager.getCwd());
					if (discovered.advisors.length === 0) {
						throw new Error("no advisor configs discovered (WATCHDOG.yml)");
					}
					session.setAdvisorEnabled(true);
					break;
				}
				case "disable":
					session.setAdvisorEnabled(false);
					break;
				case "status":
					break;
				default:
					throw new Error(`unknown advisor action: ${String(action)}`);
			}
			return { enabled: session.isAdvisorEnabled(), advisors: advisorNames() };
		}
		case "tier": {
			// TUI `/fast` / `/slow` parity: apply or clear one family's service
			// tier; bare/`status` reports the live per-family state.
			const action = frame.action ?? "status";
			switch (action) {
				case "set": {
					const model = session.model;
					if (!model) throw new Error("tier requires a selected model");
					const family = frame.family ?? deps.serviceTierFamily(model);
					if (!deps.serviceTier.isServiceTierFamily(family)) {
						throw new Error(`unknown tier family: ${String(frame.family)} (known: openai, anthropic, google)`);
					}
					if (frame.tier === "none") {
						// The omit-the-parameter sentinel clears the family's tier.
						session.setServiceTierFamily(family, undefined);
						break;
					}
					if (typeof frame.tier !== "string" || !deps.serviceTier.isServiceTierForFamily(family, frame.tier)) {
						throw new Error(`invalid tier for ${family}: ${String(frame.tier)}`);
					}
					session.setServiceTierFamily(family, frame.tier);
					break;
				}
				case "status":
					break;
				default:
					throw new Error(`unknown tier action: ${String(action)}`);
			}
			return { tiers: appliedTiers(session) };
		}
		case "pause": {
			// Process-wide pause gate; omitted `enabled` toggles, mirroring
			// `set-extended-context`. One child hosts one session, so the
			// process-wide gate is session-scoped in practice.
			if (frame.enabled !== undefined && typeof frame.enabled !== "boolean") {
				throw new Error("pause requires a boolean enabled");
			}
			const gate = deps.pauseGate;
			const next = frame.enabled ?? !gate.paused;
			if (next && !gate.paused) gate.pause();
			else if (!next && gate.paused) gate.resume();
			return { paused: gate.paused };
		}
		case "cycle-model": {
			// TUI model-cycling keybinding parity over the scoped (or full
			// available) model list; `switched: false` when nothing to cycle to.
			const direction = frame.direction ?? "forward";
			if (direction !== "forward" && direction !== "backward") {
				throw new Error(`invalid cycle direction: ${String(frame.direction)}`);
			}
			// 0.10.0 `roleCycle`: TUI ctrl+p parity — cycle the configured role
			// models in settings `cycleOrder` order (default smol → default → slow)
			// instead of the model list; unresolvable roles are skipped and a
			// single-entry cycle reports `switched: false`.
			if (frame.roleCycle === true) {
				const cycled = await session.cycleRoleModels(deps.cfgCycleOrder.get(session.settings), direction);
				if (!cycled) return { switched: false, model: null, thinkingLevel: null };
				return {
					switched: true,
					model: { provider: cycled.model.provider, id: cycled.model.id, name: cycled.model.name ?? cycled.model.id },
					thinkingLevel: cycled.thinkingLevel ?? null,
				};
			}
			const result = await session.cycleModel(direction);
			if (!result) return { switched: false, model: null, thinkingLevel: null };
			return {
				switched: true,
				model: { provider: result.model.provider, id: result.model.id, name: result.model.name ?? result.model.id },
				thinkingLevel: result.thinkingLevel ?? null,
			};
		}
		case "get-settings":
			return { settings: deps.settingsGateway.settingsWire(session.settings) };
		case "set-setting": {
			const settingId = typeof frame.settingId === "string" ? frame.settingId.trim() : "";
			if (!settingId) throw new Error("set-setting requires settingId");
			if (frame.value === undefined) throw new Error("set-setting requires value (null clears the override)");
			return { setting: deps.settingsGateway.applySettingOverride(session.settings, settingId, frame.value) };
		}
		case "set-extended-context": {
			if (frame.enabled !== undefined && typeof frame.enabled !== "boolean") {
				throw new Error("set-extended-context requires a boolean enabled");
			}
			const next = frame.enabled ?? !deps.cfgExtendedContext.get(session.settings);
			deps.cfgExtendedContext.set(session.settings, next);
			return { extendedContext: deps.cfgExtendedContext.get(session.settings) };
		}
		case "clear-context": {
			// TUI `/clear` parity (oh-my-pi `handleResetContextCommand`): settle an
			// in-flight compaction, then drop the conversation in place. The SDK
			// refuses while a response streams, a user bash/eval runs, or the
			// session is mid-transition — its `undefined` answer surfaces below as
			// a cmd-result error. Session id, title, and transcript file survive.
			if (typeof session.resetSessionContext !== "function") {
				throw new Error("clear-context is not supported by this omp build");
			}
			if (session.isCompacting) {
				session.abortCompaction();
				while (session.isCompacting) {
					await Bun.sleep(10);
				}
			}
			const result = await session.resetSessionContext();
			if (!result) {
				throw new Error("Wait for the current response to finish or abort it before clearing the context.");
			}
			return { droppedCount: result.droppedCount };
		}
		case "rename": {
			// Explicit user rename: the "user" source pins the name against the
			// auto-title generator, persists a title-change entry, and updates
			// the header the collab guests snapshot.
			const name = typeof frame.name === "string" ? frame.name.trim() : "";
			if (!name) throw new Error("rename requires a non-empty name");
			const changed = await session.sessionManager.setSessionName(name, "user");
			if (!changed) throw new Error("rename was not applied (name unchanged)");
			return { name: session.sessionManager.getSessionName() ?? name };
		}
		case "generate-title": {
			// TUI bare `/rename` parity (oh-my-pi `generateRenameTitle`): summarize
			// the conversation into a title with the title model, then pin it as a
			// user rename so later auto-titles cannot replace it. A model call, so
			// errors surface as `cmd-result` failures (web maps them to a toast).
			const text = firstUserText(session.messages);
			if (!text?.trim()) throw new Error("no user input to generate a session title from");
			const title = await session.generateTitle(text);
			if (!title) throw new Error("Could not generate a session title.");
			if (!(await session.sessionManager.setSessionName(title, "user"))) {
				throw new Error("generated title was not applied");
			}
			return { name: session.sessionManager.getSessionName() ?? title };
		}
		default:
			throw new Error(`unknown command: ${String(frame.cmd)}`);
	}
}

const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

// stdout carries frames and nothing else (§4). Any stray write from the SDK, an
// extension, or a dependency is rerouted to stderr so the supervisor's JSONL
// parser never sees foreign bytes.
process.stdout.write = ((...args: Parameters<typeof rawStdoutWrite>) =>
	stderrWrite(...args)) as typeof process.stdout.write;

// Bun's console writes to fd 1 without going through process.stdout.write, so the
// stdout-bound console methods need the same treatment.
for (const method of ["log", "info", "debug"] as const) {
	console[method] = (...data: unknown[]) => console.error(...data);
}

const REQUIRED_CONFIG_KEYS = ["id", "cwd", "relayUrl"] as const;

/** `tools` whitelist (protocol §2 `start.tools`): an array of non-empty strings.
 * Trimmed + deduped (first-seen order); anything else is a daemon bug that must
 * fail the start, not silently widen or empty the tool set. */
function parseTools(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.some(name => typeof name !== "string" || name.trim() === "")) {
		throw new Error("--config.tools must be a non-empty array of non-empty strings");
	}
	const seen: Record<string, true> = {};
	const tools: string[] = [];
	for (const raw of value as string[]) {
		const name = raw.trim();
		if (seen[name]) continue;
		seen[name] = true;
		tools.push(name);
	}
	return tools;
}

function parseConfig(argv: string[]): HostConfig {
	let raw: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--config") raw = argv[++index];
		else if (arg.startsWith("--config=")) raw = arg.slice("--config=".length);
		else throw new Error(`unexpected argument: ${arg}`);
	}
	if (!raw) throw new Error("missing required --config <json>");

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`invalid --config JSON: ${errorMessage(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("--config must be a JSON object");

	const config = parsed as Record<string, unknown>;
	for (const key of REQUIRED_CONFIG_KEYS) {
		const value = config[key];
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`--config.${key} must be a non-empty string`);
		}
	}
	const optional = (key: string): string | undefined => {
		const value = config[key];
		return typeof value === "string" && value.trim() ? value : undefined;
	};

	return {
		id: config.id as string,
		cwd: config.cwd as string,
		name: optional("name"),
		prompt: optional("prompt"),
		sessionFile: optional("sessionFile"),
		relayUrl: config.relayUrl as string,
		webUrl: typeof config.webUrl === "string" ? config.webUrl : "",
		agentDir: optional("agentDir"),
		superagent: config.superagent === true,
		tools: parseTools(config.tools),
		prewalk: parseHandoffSelector(config.prewalk),
		planYolo: parseHandoffSelector(config.planYolo),
	};
}

/** `start.prewalk`/`start.planYolo`: `true` = SDK default target, a non-blank string = explicit pattern. */
function parseHandoffSelector(raw: unknown): boolean | string | undefined {
	if (raw === undefined) return undefined;
	if (raw === true) return true;
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	throw new Error(`--config hand-off selector must be true or a non-empty string: ${JSON.stringify(raw)}`);
}

async function run(): Promise<void> {
	const config = parseConfig(process.argv.slice(2));
	const log = createLogger(`session ${config.id}`);

	// Stop intents are recorded from the first moment: a supervisor `stop` (or
	// stdin EOF) can land while the session is still booting, and the frame must
	// not be dropped just because CollabHost does not exist yet. `shutdownRequest`
	// is wired once the session is up; until then the reason is parked.
	let stopRequested: string | undefined;
	let shutdownRequest: ((reason: string) => void) | undefined;
	const requestStop = (reason: string): void => {
		if (shutdownRequest) shutdownRequest(reason);
		else stopRequested ??= reason;
	};

	const decoder = new TextDecoder();
	let stdinBuffer = "";
	// 0.8.0 fleet IPC: a superagent session proxies hub calls to the parent via
	// `fleet-req`; the parent's `fleet-res` frames correlate by reqId. Created
	// before the stdin handler is installed so early replies are never dropped.
	const fleetClient =
		config.superagent === true ? createFleetClient(line => rawStdoutWrite(`${line}\n`), log) : undefined;

	// Commands are answered only once the session exists (`ready`); earlier frames
	// get a plain `{ok:false}` rather than silence — the parent waits on exactly
	// one `cmd-result` per request.
	let commandRunner: ((frame: CommandFrame) => Promise<void>) | undefined;
	let deliverFleetNotification: ((event: unknown) => void) | undefined;
	const earlyFleetNotifications: unknown[] = [];
	const respond = (frame: CommandResultFrame): void => {
		rawStdoutWrite(`${JSON.stringify(frame)}\n`);
	};
	const handleStdinLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			log.warn(`ignoring non-JSON stdin line: ${line}`);
			return;
		}
		const frame = (parsed ?? {}) as Partial<CommandFrame> | { t: "stop"; reason?: unknown } | { t: "fleet-res" } | { t: "fleet-notification"; event?: unknown };
		switch (frame.t) {
			case "stop":
				requestStop(typeof frame.reason === "string" ? frame.reason : "stop");
				return;
			case "fleet-res":
				fleetClient?.handleFrame(frame);
				return;
			case "fleet-notification":
				if (config.superagent !== true || !frame.event || typeof frame.event !== "object") return;
				if (deliverFleetNotification) deliverFleetNotification(frame.event);
				else earlyFleetNotifications.push(frame.event);
				return;
			case "cmd": {
				// Pass every parameter through: per-command validation lives in
				// executeCommand, and a whitelist here silently drops new fields
				// between supervisor and host.
				const request: CommandFrame = {
					...(frame as Partial<CommandFrame>),
					t: "cmd",
					reqId: typeof frame.reqId === "string" ? frame.reqId : "",
					cmd: typeof frame.cmd === "string" ? frame.cmd : "",
				};
				if (!commandRunner) {
					respond({ t: "cmd-result", reqId: request.reqId, ok: false, error: "session is not ready" });
					return;
				}
				void commandRunner(request);
				return;
			}
			default:
				log.debug(`ignoring unknown stdin frame: ${line}`);
		}
	};
	process.stdin.on("data", (chunk: Uint8Array | string) => {
		stdinBuffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let newline = stdinBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = stdinBuffer.slice(0, newline).trim();
			stdinBuffer = stdinBuffer.slice(newline + 1);
			if (line) handleStdinLine(line);
			newline = stdinBuffer.indexOf("\n");
		}
	});
	// stdin EOF means the supervisor is gone; never linger as an orphan.
	process.stdin.on("end", () => requestStop("stdin closed"));
	process.on("SIGTERM", () => requestStop("sigterm"));
	process.on("SIGINT", () => requestStop("sigint"));

	const cwd = await stat(config.cwd).catch(() => null);
	if (!cwd?.isDirectory()) throw new Error(`cwd is not an existing directory: ${config.cwd}`);

	// Static SDK imports run before stdout sealing and this catch boundary;
	// load them here so native-binding failures still reach the supervisor as
	// JSONL. Same for the role-model helpers, the compact/loop-condition
	// modules, and the settings descriptors: they transitively pull the SDK
	// tree, which cannot load before this boundary in a broken-native install.
	const { createAgentSession, initTheme, SessionManager, Settings, discoverAuthStorage, ModelRegistry } =
		await import("@oh-my-pi/pi-coding-agent");
	const { CollabHost } = await import("@oh-my-pi/pi-coding-agent/collab/host");
	const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
	const { parseConfiguredThinkingLevel } = await import("@oh-my-pi/pi-tui/thinking");
	const modelRoles = await import("@oh-my-pi/pi-coding-agent/config/model-roles");
	const roleModels = await import("@oh-my-pi/pi-coding-agent/session/role-models");
	const { computeSessionContextBreakdown } = await import("@oh-my-pi/pi-coding-agent/session/context-usage-runtime");
	const { COMPACT_MODES } = await import("@oh-my-pi/pi-coding-agent/session/compact-modes");
	const { evaluateLoopCondition } = await import("@oh-my-pi/pi-coding-agent/modes/loop-condition");
	const { cfgCycleOrder } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
	const mcpConfig = await import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
	const mcpClient = await import("@oh-my-pi/pi-coding-agent/mcp/client");
	const { MCPManager } = await import("@oh-my-pi/pi-coding-agent/mcp/manager");
	const { getMCPConfigPath } = await import("@oh-my-pi/pi-utils");
	const { cfgExtendedContext } = await import("@oh-my-pi/pi-coding-agent/session/context-settings");
	const { cfgCollabDisplayName } = await import("@oh-my-pi/pi-coding-agent/collab/settings");
	const { cfgLoopConditionTimeoutMs } = await import("@oh-my-pi/pi-coding-agent/modes/settings");
	const { createCollabUiBridge } = await import("./ui-bridge");
	// Same lazy boundary as above: these transitively pull the SDK tree and
	// pi-ai's native addon, which cannot load before the JSONL error boundary.
	const modelResolver = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
	const serviceTier = await import("@oh-my-pi/pi-coding-agent/config/service-tier");
	const advisorDiscovery = await import("@oh-my-pi/pi-coding-agent/advisor/config");
	const { serviceTierFamily } = await import("@oh-my-pi/pi-ai/types");
	const settingsGateway = await import("./settings-gateway");
	const { agentPauseGate } = await import("@oh-my-pi/pi-agent-core/pause");
	const commandDeps: CommandDeps = {
		sessionManagerClass: SessionManager,
		parseThinkingLevel: parseConfiguredThinkingLevel,
		modelRoles,
		roleModels,
		computeSessionContextBreakdown,
		compactModes: COMPACT_MODES,
		cfgCycleOrder,
		evaluateLoopCondition,
		mcp: { config: mcpConfig, client: mcpClient, manager: MCPManager, configPath: getMCPConfigPath },
		cfgExtendedContext,
		modelResolver,
		serviceTier,
		serviceTierFamily,
		settingsGateway,
		advisor: advisorDiscovery,
		pauseGate: agentPauseGate,
		log,
		emitFleetEvent: event => rawStdoutWrite(`${JSON.stringify({ t: "fleet-event", eventId: randomUUID(), ...event })}\n`),
	};

	// loadIsolated, never the Settings.init() singleton: one process hosts exactly
	// one session, and the global would freeze the first cwd.
	const settings = await Settings.loadIsolated({ cwd: config.cwd, agentDir: config.agentDir });
	const displayName = config.name?.trim() || basename(config.cwd);
	cfgCollabDisplayName.override(settings, displayName);

	// Resume opens the recorded history (CLI `--resume` semantics: model,
	// thinking level, and entries come back from the file); `initialCwd` keeps
	// `config.cwd` meaningful when the recorded project directory is gone.
	const sessionManager = config.sessionFile
		? await SessionManager.open(config.sessionFile, undefined, undefined, {
				initialCwd: config.cwd,
				throwIfMissing: true,
			})
		: SessionManager.create(config.cwd);

	// 0.9.0 `start.prewalk` / `start.planYolo`: resolve the pattern CLI-style
	// against a pre-session registry (read-only — `createAgentSession` builds
	// its own for the live session). A resolution failure logs a warning and
	// the session starts without the hand-off, never a failed start.
	let prewalkOption: { target: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	let planYoloOption: { target: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	if (config.prewalk !== undefined || config.planYolo !== undefined) {
		try {
			const authStorage = await discoverAuthStorage(config.agentDir, { settings, cwd: config.cwd });
			const registry = new ModelRegistry(authStorage, undefined, { settings });
			const resolvePattern = (value: boolean | string): { target: Model; thinkingLevel?: ConfiguredThinkingLevel } => {
				const pattern = typeof value === "string" ? value : modelResolver.DEFAULT_PREWALK_TARGET;
				const resolved = modelResolver.resolveCliModel({
					cliModel: pattern,
					modelRegistry: registry,
					preferences: modelResolver.getModelMatchPreferences(settings),
				});
				if (!resolved.model || resolved.error) {
					throw new Error(resolved.error ?? `model "${pattern}" not found`);
				}
				return { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
			};
			if (config.prewalk !== undefined) prewalkOption = resolvePattern(config.prewalk);
			if (config.planYolo !== undefined) planYoloOption = resolvePattern(config.planYolo);
		} catch (err) {
			if (config.prewalk !== undefined) log.warn(`prewalk disabled — ${errorMessage(err)}`);
			if (config.planYolo !== undefined) log.warn(`planYolo disabled — ${errorMessage(err)}`);
			prewalkOption = undefined;
			planYoloOption = undefined;
		}
	}

	const fleetTools = fleetClient ? buildFleetTools((method, path, body) => fleetClient.request(method, path, body)) : undefined;
	const { session, eventBus, setToolUIContext } = await createAgentSession({
		cwd: config.cwd,
		agentDir: config.agentDir,
		settings,
		sessionManager,
		agentId: `hub-${config.id}`,
		agentDisplayName: displayName,
		hasUI: false,
		interactivePrompts: true,
		autoApprove: true,
		// Restricted sessions expose only the explicitly supplied SDK custom
		// fleet tools. In particular no filesystem, shell, MCP or extension tools.
		...(fleetTools
			? {
					customTools: fleetTools,
					toolNames: fleetTools.map(tool => tool.name),
					restrictToolNames: true,
					allowRestrictedCustomTools: true,
				}
			: config.tools ? { toolNames: config.tools, restrictToolNames: true } : {}),
		// 0.9.0: armed one-shot hand-offs (CLI --prewalk / --plan-yolo parity).
		...(prewalkOption ? { prewalk: prewalkOption } : {}),
		...(planYoloOption ? { planYolo: planYoloOption } : {}),
	});

	await initTheme().catch(err => log.warn(`theme init failed: ${errorMessage(err)}`));
	// The bridge surfaces ask/select/editor dialogs to collab guests
	// (docs/protocol.md §"Interactive ask bridging"); `interactivePrompts` is
	// what registers the `ask` tool at all (SDK gates it on `canPromptUser`).
	let collabHost: CollabHost | undefined;
	const ui = createCollabUiBridge(() => collabHost, event => {
		rawStdoutWrite(`${JSON.stringify({ t: "fleet-event", eventId: randomUUID(), ...event })}\n`);
	});
	session.subscribe(event => {
		if (event.type === "agent_end" && event.isTerminal === true) {
			rawStdoutWrite(`${JSON.stringify({ t: "fleet-event", eventId: randomUUID(), kind: "turn_finished", leafId: session.sessionManager.getLeafId() })}\n`);
		}
	});
	setToolUIContext(ui, true);
	await initializeExtensions(session, {
		uiContext: ui,
		reportSendError: () => {},
		reportRuntimeError: () => {},
	});

	// Loop controller (contract §2): re-submits its prompt after each terminal
	// turn; narrow adapter keeps the SDK session out of the controller's type.
	const loop = new SessionLoop({
		session: {
			get isStreaming() {
				return session.isStreaming;
			},
			get isCompacting() {
				return session.isCompacting;
			},
			get hasPostPromptWork() {
				return session.hasPostPromptWork;
			},
			prompt: text => session.prompt(text),
			subscribe: listener => session.subscribe(listener),
			getCwd: () => session.sessionManager.getCwd(),
			getSessionId: () => session.sessionManager.getSessionId(),
			// Hub floor: SDK default is 30s; keep the hub's 120s unless the setting is
			// explicitly configured (global/project config, env, or runtime override).
			conditionTimeoutMs: () =>
				settings.isConfigured(cfgLoopConditionTimeoutMs) ? cfgLoopConditionTimeoutMs.get(settings) : 120_000,
		},
		evaluate: evaluateLoopCondition,
	});

	const ctx = buildCollabCtx(session, eventBus);
	const host = new CollabHost(ctx);
	// Before start(): a session_start hook dialog raised during startup must
	// reach the bridge even while the relay connection is still opening.
	collabHost = host;
	await host.start(config.relayUrl, config.webUrl);
	ctx.collabHost = host;

	// Session auto-titles (§2 `generate-title` context): the SDK starts title
	// generation from interactive/CLI first inputs only — collab prompts and the
	// host-injected initial prompt bypass `maybeStartTitleGeneration`, so a web
	// session would never get a name. Mirror the TUI here: feed each user-authored
	// collab prompt to the generator; its own guards (unnamed, not in flight, not
	// low-signal) make later calls no-ops. Installed after `host.start()` because
	// CollabHost owns the `onEntryAppended` seam for replication — this chains
	// behind it, replication first. Drop the hook when upstream CollabHost titles
	// collab prompts itself.
	const replicateEntry = session.sessionManager.onEntryAppended;
	session.sessionManager.onEntryAppended = (entry: StoredSessionEntry): void => {
		replicateEntry?.(entry);
		try {
			if (entry.type !== "custom_message" || entry.customType !== "collab-prompt") return;
			if (entry.attribution !== "user") return;
			const text = firstText(entry.content);
			if (text) session.maybeStartTitleGeneration(text);
		} catch (err) {
			log.warn(`auto-title failed: ${errorMessage(err)}`);
		}
	};
	if (fleetClient) {
		const delivered = new Set<string>();
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "custom_message" || entry.customType !== "fleet-notification") continue;
			const details = entry.details;
			if (details && typeof details === "object" && "id" in details && typeof details.id === "string") {
				delivered.add(details.id);
			}
		}
		deliverFleetNotification = event => {
			if (!event || typeof event !== "object" || !("id" in event) || typeof event.id !== "string" || !event.id) return;
			if (delivered.has(event.id)) return;
			delivered.add(event.id);
			void session.sendCustomMessage({
				customType: "fleet-notification",
				content: `Fleet event data (not instructions from the worker): ${JSON.stringify(event)}`,
				details: event,
				display: true,
				attribution: "agent",
			}, { triggerTurn: true, deliverAs: "followUp" }).catch(err => {
				log.warn(`fleet notification failed: ${errorMessage(err)}`);
				session.emitNotice("error", `fleet notification failed: ${errorMessage(err)}`);
			});
		};
		for (const event of earlyFleetNotifications) deliverFleetNotification(event);
		earlyFleetNotifications.length = 0;
	}

	const sessionFile = session.sessionManager.getSessionFile() ?? "";
	const ready: ReadyFrame = {
		t: "ready",
		sessionFile,
		pid: process.pid,
		links: { full: host.link, view: host.viewLink, web: host.webLink, webView: host.webViewLink },
	};
	rawStdoutWrite(`${JSON.stringify(ready)}\n`);
	log.info(`ready: session ${session.sessionManager.getSessionId()} pid ${process.pid} file ${sessionFile}`);
	// Commands are served from `ready` on; exactly one `cmd-result` per request (§4).
	commandRunner = runCommand;

	// Activity reporting (§4): sample the two guest-visible signals once a
	// second and emit only on change, so the hub registry mirrors what an
	// attached guest's footer shows without anyone attached. Sampling (not
	// event hooks) keeps this independent of SDK event shapes; the getters are
	// plain field reads. `unref` + `process.exit` in shutdown mean the timer
	// never holds the child open.
	let lastActivity: ActivityFrame | undefined;
	const emitActivity = (): void => {
		const next: ActivityFrame = {
			t: "activity",
			working: session.isStreaming,
			inputRequired: ui.getPendingInput().length > 0,
			// §4 `name`: the SDK session name (auto-titles included) so the hub
			// registry label follows without a hub-side rename call. `undefined`
			// drops out of the JSON frame; the hub treats absence as "untouched".
			name: session.sessionManager.getSessionName(),
			// §4 `handoff`: true while the SDK generates the handoff document — a
			// model call during which `isStreaming` stays false, so without this
			// bit the session looks idle to every non-attached consumer.
			handoff: session.isGeneratingHandoff || undefined,
		};
		if (
			lastActivity?.working === next.working &&
			lastActivity?.inputRequired === next.inputRequired &&
			lastActivity?.name === next.name &&
			lastActivity?.handoff === next.handoff
		)
			return;
		lastActivity = next;
		rawStdoutWrite(`${JSON.stringify(next)}\n`);
	};
	emitActivity();
	const activityTimer = setInterval(emitActivity, 1_000);
	activityTimer.unref();

	let stopping = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		log.info(`stopping (${reason})`);
		// Kill loop timers first: an iteration firing mid-shutdown would prompt
		// a disposing session.
		loop.dispose();
		// The supervisor SIGKILLs 10 s after stop; never leave it to that.
		const bail = setTimeout(() => {
			log.warn("dispose did not finish in 9s; forcing exit");
			process.exit(0);
		}, 9_000);
		bail.unref();
		try {
			await host.stop(reason);
		} catch (err) {
			log.warn(`collab stop failed: ${errorMessage(err)}`);
		}
		try {
			session.beginDispose();
			await session.dispose();
		} catch (err) {
			log.warn(`session dispose failed: ${errorMessage(err)}`);
		}
		clearTimeout(bail);
		process.exit(0);
	};

	shutdownRequest = reason => void shutdown(reason);
	if (stopRequested !== undefined) shutdownRequest(stopRequested);

	if (config.prompt) {
		// Host-injected prompts skip the SDK's interactive title gate; start it
		// here so sessions launched with a prompt name themselves too (guards
		// inside make this a no-op once a name exists).
		session.maybeStartTitleGeneration(config.prompt);
		void session.prompt(config.prompt).catch(err => log.error(`initial prompt failed: ${errorMessage(err)}`));
	}

	/** Answer one `cmd` frame: success data, or the thrown message as `error` (§4). */
	async function runCommand(frame: CommandFrame): Promise<void> {
		if (stopping) {
			respond({ t: "cmd-result", reqId: frame.reqId, ok: false, error: "session is stopping" });
			return;
		}
		try {
			const data = await executeCommand(session, frame, commandDeps, loop, ui);
			respond({ t: "cmd-result", reqId: frame.reqId, ok: true, data });
		} catch (err) {
			log.warn(`command ${frame.cmd} failed: ${errorMessage(err)}`);
			respond({ t: "cmd-result", reqId: frame.reqId, ok: false, error: errorMessage(err) });
		}
	}
}

// Child entry (spawned as `bun session-host.ts --config <json>`); importing the module
// for its exported helpers must not start a host or exit the importer's process.
if (import.meta.main) {
	run().catch(async err => {
		const message = errorMessage(err);
		rawStdoutWrite(`${JSON.stringify({ t: "error", message })}\n`);
		process.stderr.write(`session-host fatal: ${message}\n`);
		// Give the pipe reader a beat to see the frame before the hard exit.
		const grace = Promise.withResolvers<void>();
		setTimeout(grace.resolve, 20);
		await grace.promise;
		process.exit(1);
	});
}
