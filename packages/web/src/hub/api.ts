/**
 * Hub HTTP API client (docs/protocol.md §3).
 *
 * The token (`omp-hub.token`) and display name (`omp-hub.name`) live in
 * localStorage; every request carries `Authorization: Bearer <token>`.
 */

export type SessionStatus = "starting" | "live" | "exited" | "failed";

export interface SessionLinks {
	full: string;
	view: string;
	web: string;
	webView: string;
}

export interface SessionRecord {
	id: string;
	machineId: string;
	machineName: string;
	cwd: string;
	name: string;
	/** Named omp profile the session runs under; absent means the default profile. */
	profile?: string;
	/** Fleet-operator session (protocol §2 `start.superagent`, §4 fleet-req); set at start. */
	superagent?: true;
	/** Callable-tool whitelist (protocol §2 `start.tools`); absent means the default tool set. */
	tools?: string[];
	status: SessionStatus;
	startedAt: number;
	exitedAt?: number;
	exitReason?: string;
	error?: string;
	links?: SessionLinks;
	sessionFile?: string;
	pid?: number;
	/** Last known working/input state mirrored from the agent; absent on older agents. */
	activity?: { working: boolean; inputRequired: boolean; handoff?: boolean; updatedAt: number };
}

export interface MachineRecord {
	machineId: string;
	name: string;
	connected: boolean;
	connectedAt: number;
	sessionCount: number;
	/** Agent-reported temp directory (`os.tmpdir()`); missing from pre-0.3.0 agents. */
	tmpdir?: string;
	/** Daemon upgrade restart in flight; sessions resume under their old ids when it lands. */
	restarting?: true;
}

export interface StartSessionRequest {
	machineId: string;
	cwd: string;
	name?: string;
	prompt?: string;
	/** Named omp profile; omitted means the default profile. */
	profile?: string;
	/** Resume an existing omp session file instead of minting a new one. */
	sessionFile?: string;
	/** Start a fleet-operator session (protocol §2 `start.superagent`). */
	superagent?: boolean;
	/** Restrict the session to exactly these tools (protocol §2 `start.tools`); omitted means the default set. */
	tools?: string[];
	/**
	 * Arm the one-shot prewalk hand-off at startup (protocol §2 `start.prewalk`,
	 * 0.9.0+): `true` targets the SDK default (`@smol`), a string is an explicit
	 * model/role pattern.
	 */
	prewalk?: boolean | string;
	/** Arm plan mode's one-shot model hand-off at startup (protocol §2, 0.9.0+). */
	planYolo?: boolean | string;
}

/** One model the session can switch to (docs/protocol.md §2 `AgentState`). */
export interface AgentModel {
	provider: string;
	id: string;
	name: string;
	/** Efforts the model declares; empty for non-reasoning models. */
	thinkingEfforts: string[];
	/** Effort applied when the model is selected; null means the agent default. */
	defaultThinkingLevel: string | null;
}

/** One chat-section model role and its current assignment (docs/protocol.md §2). */
export interface AgentRole {
	/** Role id (`"default"`, `"smol"`, `"slow"`, …). */
	role: string;
	/** Display name (`"Default"`, `"Fast"`, `"Thinking"`, …). */
	name: string;
	/** Currently assigned model; `null` when the role is unconfigured. */
	model: AgentModel | null;
	/** `model` is auto-selected — the role has no configured value (0.10.0+ agents). */
	auto?: boolean;
}

/** Agent-side session state behind the slash-command pickers (docs/protocol.md §2). */
export interface AgentState {
	sessionName: string;
	cwd: string;
	model: AgentModel | null;
	/** Effective level, never `"auto"`. */
	thinkingLevel: string | null;
	/** Levels valid for the current model. */
	thinkingLevels: string[];
	/** Auth-available models. */
	models: AgentModel[];
	/** Chat-section roles with their resolved assignments. */
	roles: AgentRole[];
	/** Whether the session reads beyond the default context window. */
	extendedContext: boolean;
	/** Active goal-mode state; null when no goal exists. */
	goal: GoalModeState | null;
	/** Loop-controller status; null when the loop is disabled. */
	loop: LoopStatus | null;
	/** Top-level callable tools, sorted (0.9.0+ agents only); reflects a `start.tools` whitelist. */
	tools?: string[];
	/** Armed one-shot model hand-off; null when disarmed (0.9.0+). */
	prewalk: PrewalkState | null;
	/** Plan-mode state; null when the SDK reports none (0.9.0+). */
	plan: PlanState | null;
	/** Second-model advisor toggle (0.9.0+). */
	advisor: { enabled: boolean };
	/** Process-wide pause gate for this child (0.9.0+). */
	paused: boolean;
	/** Applied service tiers, provider family → tier (0.9.0+). */
	tiers: Record<string, string>;
}

/** Armed prewalk hand-off (agent `get-state.prewalk`, protocol §2). */
export interface PrewalkState {
	provider: string;
	id: string;
	name: string;
	thinkingLevel: string | null;
}

/** Plan-mode state (agent `get-state.plan`, protocol §2). */
export interface PlanState {
	enabled: boolean;
	planFilePath: string;
	/** `"parallel"` | `"iterative"` when the SDK reports one. */
	workflow: string | null;
}

/** One allowlisted session setting (agent `get-settings`, protocol §2). */
export interface SettingWire {
	/** Descriptor id, e.g. `"compaction.thresholdPercent"`. */
	id: string;
	/** JSON-safe current value (override wins over config). */
	value: unknown;
	/** Descriptor default; null when none. */
	defaultValue: unknown;
	/** `"boolean" | "enum" | "number" | "string" | "array" | "record"`. */
	type: string;
	/** Enum settings only: allowed values in order. */
	values?: string[];
	/** TUI `/settings` tab hint, e.g. `"context"`. */
	tab?: string;
	/** TUI `/settings` group hint, e.g. `"Compaction"`. */
	group?: string;
	description: string;
	/** Present in user/project config. */
	configured: boolean;
	/** Session runtime override active. */
	overridden: boolean;
}

/** The session's tracked goal object (agent `get-state.goal.goal`). */
export interface SessionGoal {
	id: string;
	objective: string;
	status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

/** Goal-mode state behind the goal modal (agent `get-state.goal`). */
export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: SessionGoal;
}

/**
 * Iteration or time budget of a session loop. Requests send only `kind` +
 * the amount; the agent's status report adds `iterationsLeft` / `deadlineMs`.
 */
export type LoopLimit =
	| { kind: "iterations"; iterations: number; iterationsLeft?: number }
	| { kind: "duration"; durationMs: number; deadlineMs?: number };

/** Shell command re-evaluated before each loop iteration. */
export interface LoopCondition {
	/** Continue while the command succeeds (`until: false`) or until it succeeds (`until: true`). */
	command: string;
	until: boolean;
}

/** Loop-controller status behind the loop modal (agent `get-state.loop`). */
export interface LoopStatus {
	state: "waiting" | "running" | "paused";
	prompt?: string;
	limit?: LoopLimit;
	condition?: LoopCondition;
}

export const TOKEN_KEY = "omp-hub.token";
export const NAME_KEY = "omp-hub.name";
export const DEFAULT_DISPLAY_NAME = "guest";

/** Non-2xx API reply; `status` is the HTTP status, `message` the `{error}` field. */
export class HubApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HubApiError";
		this.status = status;
	}
}

/**
 * In-memory mirror of the two keys. localStorage is missing or throws in some
 * contexts (private mode, blocked storage, tests); the store must still serve
 * the token for the life of the page instead of degrading to unauthenticated
 * requests.
 */
const memory = new Map<string, string | null>();

function readStored(key: string): string | null {
	if (memory.has(key)) return memory.get(key) ?? null;
	try {
		const value = globalThis.localStorage?.getItem(key) ?? null;
		memory.set(key, value);
		return value;
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string | null): void {
	memory.set(key, value);
	try {
		if (value === null) globalThis.localStorage?.removeItem(key);
		else globalThis.localStorage?.setItem(key, value);
	} catch {
		// persistence is best-effort; the in-memory value still serves this page
	}
}

export function getToken(): string | null {
	return readStored(TOKEN_KEY);
}

export function setToken(token: string): void {
	writeStored(TOKEN_KEY, token);
}

export function clearToken(): void {
	writeStored(TOKEN_KEY, null);
}

const unauthorizedListeners = new Set<() => void>();

/** Hub token rejection invalidates any warm writable connections. */
export function onUnauthorized(listener: () => void): () => void {
	unauthorizedListeners.add(listener);
	return () => unauthorizedListeners.delete(listener);
}

export function getDisplayName(): string {
	return readStored(NAME_KEY)?.trim() || DEFAULT_DISPLAY_NAME;
}

export function setDisplayName(name: string): void {
	writeStored(NAME_KEY, name.trim() || DEFAULT_DISPLAY_NAME);
}

async function errorMessage(res: Response): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error) {
			return body.error;
		}
	} catch {
		// non-JSON error body: fall through to the status text
	}
	return res.statusText || `HTTP ${res.status}`;
}

/** Authenticated JSON request against the hub API. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	const token = getToken() ?? "";
	headers.set("Authorization", `Bearer ${token}`);
	if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	const res = await fetch(path, { ...init, headers });
	if (!res.ok) {
		if (res.status === 401 && token === getToken()) for (const listener of unauthorizedListeners) listener();
		throw new HubApiError(res.status, await errorMessage(res));
	}
	return (await res.json()) as T;
}

/**
 * Upload one binary attachment for a live session (protocol §3 `POST /api/sessions/:id/files`).
 * Resolves with the machine-absolute path to reference (`@path`) in prompts; throws
 * {@link HubApiError} on 400/404/409/413/502/504.
 */
export async function uploadSessionFile(id: string, file: File): Promise<{ path: string; bytes: number }> {
	return api<{ ok: true; path: string; bytes: number }>(`/api/sessions/${encodeURIComponent(id)}/files`, {
		method: "POST",
		headers: {
			// api() only defaults Content-Type when unset; keep the raw-body marker.
			"Content-Type": "application/octet-stream",
			// Header values are latin-1: percent-encode so non-ASCII names survive.
			"X-Filename": encodeURIComponent(file.name),
		},
		body: file,
	});
}

export async function getMachines(): Promise<MachineRecord[]> {
	return (await api<{ machines: MachineRecord[] }>("/api/machines")).machines;
}

/**
 * Panel-triggered daemon upgrade restart (protocol §3). Resolves with the
 * machine once the daemon accepted the restart; the fresh daemon reconnects on
 * its own and the hub resumes the machine's sessions under their old ids.
 * Throws {@link HubApiError} on 404/409/502/504.
 */
export async function restartDaemon(machineId: string): Promise<MachineRecord> {
	const reply = await api<{ ok: true; machine: MachineRecord }>(
		`/api/machines/${encodeURIComponent(machineId)}/restart-daemon`,
		{ method: "POST" },
	);
	return reply.machine;
}

/** Live account-level subscription quotas returned by a machine's agent. */
export interface SubscriptionLimit {
	id: string;
	label: string;
	amount: {
		unit: string;
		used?: number;
		limit?: number;
		remaining?: number;
		usedFraction?: number;
		remainingFraction?: number;
	};
	window?: {
		id: string;
		label: string;
		durationMs?: number;
		resetsAt?: number;
		resetLabel?: string;
	};
	status?: string;
	notes?: string[];
}

export interface SubscriptionReport {
	provider: string;
	account: string;
	fetchedAt: number;
	limits: SubscriptionLimit[];
	resetCredits?: { availableCount: number; redeemableCount?: number };
}

export interface SubscriptionUsage {
	fetchedAt: number;
	reports: SubscriptionReport[];
	unavailable: { provider: string; account: string }[];
}

/** Current quotas for exactly one profile; never aggregate these across profiles. */
export function getMachineSubscriptions(machineId: string, profile: string): Promise<SubscriptionUsage> {
	return api<SubscriptionUsage>(
		`/api/machines/${encodeURIComponent(machineId)}/subscriptions?profile=${encodeURIComponent(profile)}`,
	);
}

/** Time ranges the machine's stats dashboard accepts (protocol §3 usage relay). */
export type UsageRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

/** Aggregated usage counters (machine dashboard `AggregatedStats`, subset we render). */
export interface UsageAggregate {
	totalRequests: number;
	failedRequests: number;
	/** 0–1 fraction; multiply by 100 for percent (e.g. `fmtPercent(errorRate * 100)`). */
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** 0–1 fraction; multiply by 100 for percent (e.g. `fmtPercent(cacheRate * 100)`). */
	cacheRate: number;
	/** 0–1 fraction; multiply by 100 for percent. */
	cacheSavings: number;
	totalCost: number;
	unpricedRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	lastTimestamp: number;
}

/** Per-model usage row (machine dashboard `ModelStats`). */
export interface UsageModelStats extends UsageAggregate {
	model: string;
	provider: string;
}

/** One time-series bucket of the machine's stats dashboard. */
export interface UsageTimePoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

/** `/api/stats` payload of the machine's omp stats dashboard (subset we render). */
export interface MachineUsageStats {
	overall: UsageAggregate;
	byModel: UsageModelStats[];
	timeSeries: UsageTimePoint[];
}

/**
 * Usage dashboard stats for one machine, relayed from its local omp stats
 * dashboard (protocol §3 usage relay). `profile` names an omp profile
 * (0.5.0+); omitted or `"default"` selects the machine's default dashboard.
 * The hub answers 404 (unknown machine), 502 (machine offline or dashboard
 * unavailable), 504 (relay timeout) — all {@link HubApiError}.
 */
export async function getMachineUsage(machineId: string, range: UsageRange, profile?: string): Promise<MachineUsageStats> {
	const params = new URLSearchParams({ range });
	if (profile !== undefined && profile !== "default") params.set("profile", profile);
	return api<MachineUsageStats>(
		`/api/machines/${encodeURIComponent(machineId)}/usage/api/stats?${params.toString()}`,
	);
}

/** Triggers the machine's incremental session scan and returns its counts. */
export async function syncMachineUsage(
	machineId: string,
	profile?: string,
): Promise<{ processed: number; files: number; totalMessages: number }> {
	const query = profile !== undefined && profile !== "default" ? `?profile=${encodeURIComponent(profile)}` : "";
	return api(`/api/machines/${encodeURIComponent(machineId)}/usage/api/sync${query}`, { method: "POST" });
}

export async function getSessions(): Promise<SessionRecord[]> {
	return (await api<{ sessions: SessionRecord[] }>("/api/sessions")).sessions;
}

export async function getSession(id: string): Promise<SessionRecord> {
	return (await api<{ session: SessionRecord }>(`/api/sessions/${encodeURIComponent(id)}`)).session;
}

export async function startSession(input: StartSessionRequest): Promise<SessionRecord> {
	const body: StartSessionRequest = { machineId: input.machineId, cwd: input.cwd };
	if (input.name) body.name = input.name;
	if (input.prompt) body.prompt = input.prompt;
	if (input.profile) body.profile = input.profile;
	if (input.sessionFile) body.sessionFile = input.sessionFile;
	if (input.superagent) body.superagent = true;
	if (input.tools?.length) body.tools = input.tools;
	if (input.prewalk !== undefined) body.prewalk = input.prewalk;
	if (input.planYolo !== undefined) body.planYolo = input.planYolo;
	const reply = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
	return reply.session;
}

export async function stopSession(id: string): Promise<void> {
	await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

/**
 * Restart a terminal session under its old id (protocol §3): the hub re-sends
 * the stored start parameters, resuming the transcript when one exists. The
 * returned record is the same id flipped back to `starting`.
 */
export async function restartSession(id: string): Promise<SessionRecord> {
	const reply = await api<{ session: SessionRecord }>(`/api/sessions/${encodeURIComponent(id)}/restart`, { method: "POST" });
	return reply.session;
}

/**
 * Delete a session from the hub registry (a live session is stopped first).
 * The machine-side omp session file stays; `/resume` can re-attach later.
 */
export async function deleteSession(id: string): Promise<void> {
	await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Agent-side state for a live session: current model, effective thinking level,
 * and the options it can switch to. The hub answers 404 (unknown session), 409
 * (not live), 502 (agent offline), 504 (cmd timed out) — all {@link HubApiError}.
 */
export async function getAgentState(id: string): Promise<AgentState> {
	const reply = await api<{ ok: true; state: AgentState }>(`/api/sessions/${encodeURIComponent(id)}/agent-state`);
	return reply.state;
}

/** One bucket of the agent's own context estimate (docs/protocol.md §2 `SessionContext`). */
export interface ContextCategory {
	id: "systemPrompt" | "systemTools" | "systemContext" | "skills" | "messages";
	label: string;
	tokens: number;
}

/**
 * What occupies the model's context window right now, as the agent SDK
 * estimates it. `contextWindow <= 0` means no model is selected; categories are
 * approximations — message tokens are not split by role.
 */
export interface SessionContext {
	contextWindow: number;
	usedTokens: number;
	categories: ContextCategory[];
	autoCompactBufferTokens: number;
	freeTokens: number;
}

/**
 * Context breakdown for a live session (agent `get-context`, no parameters).
 * Same dispatch semantics as {@link getAgentState}: the hub answers 404
 * (unknown session), 409 (not live), 502 (agent offline), 504 (cmd timed out) —
 * all {@link HubApiError}.
 */
export async function getSessionContext(id: string): Promise<SessionContext> {
	const reply = await api<{ ok: true; context: SessionContext }>(
		`/api/sessions/${encodeURIComponent(id)}/context`,
	);
	return reply.context;
}

/**
 * Switch the session model through the agent control channel. `opts.role`
 * targets a non-default model role; the host then persists the assignment
 * unless `persist: false`. `opts.level` presets the thinking level in the same
 * command — the agent applies it after the switch, so it wins over the target
 * model's own default — and the reply carries the effective level.
 */
export async function setModel(
	id: string,
	provider: string,
	modelId: string,
	opts: { role?: string; persist?: boolean; level?: string } = {},
): Promise<{ switched: boolean; role: string; thinkingLevel: string | null }> {
	const reply = await api<{ ok: true; switched: boolean; role: string; thinkingLevel: string | null }>(
		`/api/sessions/${encodeURIComponent(id)}/model`,
		{
			method: "POST",
			body: JSON.stringify({ provider, modelId, ...opts }),
		},
	);
	return { switched: reply.switched, role: reply.role, thinkingLevel: reply.thinkingLevel };
}

/**
 * Clear a role's persisted model assignment (agent `set-model` `clearRole`,
 * 0.10.0+): auto-selection applies. `switched` reports whether the active
 * model moved — only possible when clearing `default` onto an exposed
 * persisted value.
 */
export async function clearModelRole(
	id: string,
	role: string,
): Promise<{ switched: boolean; thinkingLevel: string | null }> {
	const reply = await api<{ ok: true; switched: boolean; role: string; thinkingLevel: string | null }>(
		`/api/sessions/${encodeURIComponent(id)}/model`,
		{ method: "POST", body: JSON.stringify({ role, clearRole: true }) },
	);
	return { switched: reply.switched, thinkingLevel: reply.thinkingLevel };
}

/** Result of moving the session tree leaf (rewind). */
export interface NavigateTreeResult {
	/** A session hook cancelled the navigation; the tree is unchanged. */
	cancelled: boolean;
	/** An in-flight agent turn was aborting — retry once it settles. */
	aborted: boolean;
	/** The target prompt's text (the TUI puts it back in the composer). */
	editorText: string | null;
	leafId: string | null;
}

/**
 * Move the session tree leaf (rewind): the target entry and everything after it
 * leave the active branch; a user-message target rewinds past itself and
 * returns its text as `editorText`. `aborted` means an in-flight turn was
 * aborting — retry once settled.
 */
export async function navigateTree(
	id: string,
	entryId: string,
	opts: { summarize?: boolean } = {},
): Promise<NavigateTreeResult> {
	const { ok: _ok, ...result } = await api<NavigateTreeResult & { ok: true }>(
		`/api/sessions/${encodeURIComponent(id)}/tree`,
		{
			method: "POST",
			body: JSON.stringify({ entryId, ...opts }),
		},
	);
	return result;
}

/**
 * One node of the session tree (`get-tree`): structure plus a one-line preview,
 * never a message body. `parentId` points at the nearest node the host kept —
 * non-wire entries are pruned, children re-homed — so the shape matches what
 * the picker renders.
 */
export interface TreeWireNode {
	id: string;
	parentId: string | null;
	type: string;
	/** `message` entries only. */
	role?: string;
	/** Host-injected user prompt (not an authored turn). */
	synthetic?: true;
	/** `toolResult` messages only. */
	toolName?: string;
	/** `custom_message` entries only. */
	customType?: string;
	preview: string;
	timestamp: string;
	label?: string;
	/** On the active leaf path (root → leaf). */
	branch?: true;
	/** The current leaf. */
	leaf?: true;
	children: TreeWireNode[];
}

/** `GET /api/sessions/:id/tree` payload: the session's entry tree for `/tree`. */
export interface SessionTree {
	leafId: string | null;
	/** `true` when the host's node cap dropped the oldest subtrees. */
	truncated: boolean;
	nodes: TreeWireNode[];
}

/** The session's full entry tree (agent `get-tree`), read-only. */
export async function getSessionTree(id: string): Promise<SessionTree> {
	const { ok: _ok, ...tree } = await api<SessionTree & { ok: true }>(`/api/sessions/${encodeURIComponent(id)}/tree`);
	return tree;
}

/** Set the session thinking level; resolves the effective level after the set. */
export async function setThinking(id: string, level: string): Promise<{ thinkingLevel: string }> {
	const reply = await api<{ ok: true; thinkingLevel: string }>(`/api/sessions/${encodeURIComponent(id)}/thinking`, {
		method: "POST",
		body: JSON.stringify({ level }),
	});
	return { thinkingLevel: reply.thinkingLevel };
}

/**
 * Start compacting the session context (agent `compact`). The command is
 * background dispatch on the agent — the reply only confirms the start; the
 * summary itself streams into the transcript. Dispatch semantics as
 * {@link getAgentState}; a bad mode/instructions surface as 400.
 */
export async function postCompact(
	id: string,
	opts: { instructions?: string; mode?: string } = {},
): Promise<void> {
	await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/compact`, {
		method: "POST",
		body: JSON.stringify(opts),
	});
}

/** Outcome of a shake run (agent `shake`): what was dropped and the estimate freed. */
export interface ShakeResult {
	/** Selected diet: `elide`, `images`, or `thinking`. */
	mode: "elide" | "images" | "thinking";
	/** Whole tool-call results dropped (elide). */
	toolResultsDropped: number;
	/** Large fenced/XML blocks dropped (elide). */
	blocksDropped: number;
	/** Image blocks removed (images mode, incl. old snapcompact archive frames). */
	imagesDropped?: number;
	/** Thinking blocks dropped (thinking mode). */
	thinkingBlocksDropped?: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
}

/**
 * One-line operator summary of a {@link ShakeResult} (TUI `formatShakeSummary`
 * parity — the web package does not import the agent SDK).
 */
export function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0
			? "No images found in this session."
			: `Dropped ${n} image${n === 1 ? "" : "s"} from this session.`;
	}
	if (result.mode === "thinking") {
		const n = result.thinkingBlocksDropped ?? 0;
		return n === 0
			? "No thinking blocks found in this session."
			: `Dropped ${n} thinking block${n === 1 ? "" : "s"} from this session${result.tokensFreed > 0 ? ` (~${result.tokensFreed} tokens freed)` : ""}.`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(`${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`);
	}
	if (result.blocksDropped > 0) {
		parts.push(`${result.blocksDropped} block${result.blocksDropped === 1 ? "" : "s"}`);
	}
	if (parts.length === 0) return "Nothing to shake.";
	return `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).`;
}

/**
 * Shake heavy content out of the context (agent `shake`, TUI `/shake` parity):
 * a local transform, so the reply carries the actual counts. `mode` defaults
 * to `"elide"` on the agent; a bad mode surfaces as a 500 with the agent's
 * known-modes message.
 */
export async function postShake(id: string, mode?: string): Promise<ShakeResult> {
	const reply = await api<{ ok: true; result: ShakeResult }>(`/api/sessions/${encodeURIComponent(id)}/shake`, {
		method: "POST",
		body: JSON.stringify(mode === undefined ? {} : { mode }),
	});
	return reply.result;
}

/**
 * Summarize the session into a handoff document and compact in place (agent
 * `handoff`, TUI `/handoff` parity). Background dispatch like
 * {@link postCompact} — the reply only confirms the start; the document and
 * any failure stream through the transcript. The hub answers 409 while a
 * response is streaming or a handoff is already running.
 */
export async function postHandoff(id: string, instructions?: string): Promise<void> {
	await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/handoff`, {
		method: "POST",
		body: JSON.stringify(instructions === undefined ? {} : { instructions }),
	});
}

/**
 * Retry the session's last failed turn (agent `retry`). The hub answers 409
 * with the agent's message when there is nothing to retry or a response is
 * still streaming.
 */
export async function postRetry(id: string): Promise<void> {
	await api<{ ok: true; started: boolean }>(`/api/sessions/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

/**
 * Clear the conversation context in place (agent `clear-context`, TUI `/clear`
 * parity) and return the number of dropped messages. The session itself
 * continues. The hub answers 409 with the agent's message while a response is
 * still streaming.
 */
export async function postClearContext(id: string): Promise<number> {
	const reply = await api<{ ok: true; droppedCount: number }>(
		`/api/sessions/${encodeURIComponent(id)}/clear-context`,
		{ method: "POST" },
	);
	return reply.droppedCount;
}

export type LoopAction = "enable" | "disable" | "pause" | "resume" | "status";

/**
 * Drive the session's loop controller (agent `loop`): `enable` starts (or
 * re-configures) a repeating prompt, the other actions manage it. The reply
 * carries the controller status after the action, null when disabled. Errors
 * (bad action, malformed limit/condition) surface as 400.
 */
export async function postLoop(
	id: string,
	input: { action: LoopAction; prompt?: string; limit?: LoopLimit; condition?: LoopCondition },
): Promise<LoopStatus | null> {
	const reply = await api<{ ok: true; loop: LoopStatus | null }>(`/api/sessions/${encodeURIComponent(id)}/loop`, {
		method: "POST",
		body: JSON.stringify(input),
	});
	return reply.loop;
}

export type GoalAction = "set" | "replace" | "pause" | "resume" | "drop" | "budget";

/**
 * Drive the session's goal runtime (agent `goal`): set/replace the objective,
 * pause/resume/drop it, or move its token budget. The reply carries the
 * goal-mode state after the action, null when no goal remains. Agent-side SDK
 * errors (missing objective, no goal to resume, …) surface as 400 with the
 * SDK's own message.
 */
export async function postGoal(
	id: string,
	input: { action: GoalAction; objective?: string; tokenBudget?: number },
): Promise<GoalModeState | null> {
	const reply = await api<{ ok: true; goal: GoalModeState | null }>(`/api/sessions/${encodeURIComponent(id)}/goal`, {
		method: "POST",
		body: JSON.stringify(input),
	});
	return reply.goal;
}

/**
 * Turn the session's extended-context setting on or off; omit `enabled` to
 * toggle. Returns the resulting state.
 */
export async function postExtendedContext(id: string, opts: { enabled?: boolean } = {}): Promise<boolean> {
	const reply = await api<{ ok: true; extendedContext: boolean }>(
		`/api/sessions/${encodeURIComponent(id)}/extended-context`,
		{ method: "POST", body: JSON.stringify(opts) },
	);
	return reply.extendedContext;
}

/** Result of arming the prewalk hand-off (agent `prewalk`, protocol §2). */
export interface PrewalkResult {
	/** Present on `arm`: false means a no-op (target equals the active model). */
	armed?: boolean;
	/** Present on `restart`: `"armed"` | `"reset"` | `"rejected"`. */
	result?: "armed" | "reset" | "rejected";
	prewalk: PrewalkState | null;
}

/**
 * Drive the one-shot prewalk hand-off (agent `prewalk`, TUI `/prewalk` parity):
 * `arm` resolves `target` (a role alias like `@smol` — the default — or a
 * provider/model pattern) and arms the hand-off; `restart` restores the
 * pre-prewalk model and re-arms; bare reports the armed state.
 */
export async function postPrewalk(
	id: string,
	opts: { action?: "arm" | "restart" | "state"; target?: string } = {},
): Promise<PrewalkResult> {
	const reply = await api<{ ok: true } & PrewalkResult>(`/api/sessions/${encodeURIComponent(id)}/prewalk`, {
		method: "POST",
		body: JSON.stringify(opts),
	});
	return { armed: reply.armed, result: reply.result, prewalk: reply.prewalk };
}

/**
 * Drive plan mode (agent `plan`, TUI `/plan` parity): `enable` activates
 * read-only plan mode from the next prompt, `disable` clears it, bare reports.
 */
export async function postPlan(
	id: string,
	opts: { action?: "enable" | "disable" | "status"; planFilePath?: string } = {},
): Promise<PlanState | null> {
	const reply = await api<{ ok: true; plan: PlanState | null }>(`/api/sessions/${encodeURIComponent(id)}/plan`, {
		method: "POST",
		body: JSON.stringify(opts),
	});
	return reply.plan;
}

/**
 * Drive the second-model advisor (agent `advisor`): `enable` discovers the
 * SDK's advisor configs and turns it on (fails with none), `disable` turns it
 * off, bare reports. Returns the enabled flag and the discovered advisor names.
 */
export async function postAdvisor(
	id: string,
	opts: { action?: "enable" | "disable" | "status" } = {},
): Promise<{ enabled: boolean; advisors: string[] }> {
	const reply = await api<{ ok: true; enabled: boolean; advisors: string[] }>(
		`/api/sessions/${encodeURIComponent(id)}/advisor`,
		{ method: "POST", body: JSON.stringify(opts) },
	);
	return { enabled: reply.enabled, advisors: reply.advisors };
}

/**
 * Set or report a service tier (agent `tier`, TUI `/fast` / `/slow` parity):
 * `set` applies `tier` to `family` (`openai | anthropic | google`, omitted =
 * the current model's family); `"none"` clears. Bare reports all applied tiers.
 */
export async function postTier(
	id: string,
	opts: { action?: "set" | "status"; family?: string; tier?: string } = {},
): Promise<Record<string, string>> {
	const reply = await api<{ ok: true; tiers: Record<string, string> }>(`/api/sessions/${encodeURIComponent(id)}/tier`, {
		method: "POST",
		body: JSON.stringify(opts),
	});
	return reply.tiers;
}

/**
 * Freeze or resume the session's agent loop (agent `pause`); omit `enabled`
 * to toggle. Returns the resulting state.
 */
export async function postPause(id: string, opts: { enabled?: boolean } = {}): Promise<boolean> {
	const reply = await api<{ ok: true; paused: boolean }>(`/api/sessions/${encodeURIComponent(id)}/pause`, {
		method: "POST",
		body: JSON.stringify(opts),
	});
	return reply.paused;
}

/**
 * Cycle to the next (default) or previous model in the session's list (agent
 * `cycle-model`); `roleCycle` cycles the configured role models in
 * `cycleOrder` order instead (0.10.0+ agents); `switched: false` when there
 * is nothing to cycle to.
 */
export async function postCycle(
	id: string,
	opts: { direction?: "forward" | "backward"; roleCycle?: boolean } = {},
): Promise<{ switched: boolean; model: { provider: string; id: string; name: string } | null; thinkingLevel: string | null }> {
	const reply = await api<{
		ok: true;
		switched: boolean;
		model: { provider: string; id: string; name: string } | null;
		thinkingLevel: string | null;
	}>(`/api/sessions/${encodeURIComponent(id)}/cycle`, { method: "POST", body: JSON.stringify(opts) });
	return { switched: reply.switched, model: reply.model, thinkingLevel: reply.thinkingLevel };
}

/**
 * The hub-curated allowlist of the agent's typed settings with current values
 * (agent `get-settings`, 0.9.0+). Error set mirrors {@link getAgentState}.
 */
export async function getSessionSettings(id: string): Promise<SettingWire[]> {
	const reply = await api<{ ok: true; settings: SettingWire[] }>(`/api/sessions/${encodeURIComponent(id)}/settings`);
	return reply.settings;
}

/**
 * Apply a session-scoped runtime override for one allowlisted setting (agent
 * `set-setting`, 0.9.0+); `value: null` clears the override. Overrides never
 * persist to `settings.json` and die with the session.
 */
export async function postSessionSetting(id: string, settingId: string, value: unknown): Promise<SettingWire> {
	const reply = await api<{ ok: true; setting: SettingWire }>(`/api/sessions/${encodeURIComponent(id)}/settings`, {
		method: "POST",
		body: JSON.stringify({ settingId, value }),
	});
	return reply.setting;
}

/** Renames a live session (§2 `rename`); returns the hub's applied name. */
export async function postRename(id: string, name: string): Promise<string> {
	const reply = await api<{ ok: true; name: string; session: SessionRecord }>(
		`/api/sessions/${encodeURIComponent(id)}/rename`,
		{ method: "POST", body: JSON.stringify({ name }) },
	);
	return reply.name;
}

/** Generates a title from the conversation (§2 `generate-title`); returns the applied name. */
export async function postGenerateTitle(id: string): Promise<string> {
	const reply = await api<{ ok: true; name: string; session: SessionRecord }>(
		`/api/sessions/${encodeURIComponent(id)}/title`,
		{ method: "POST" },
	);
	return reply.name;
}

/** One configured MCP server on a listing (protocol §2 `mcp-list`): redacted config truth plus the live join. */
export interface McpServerInfo {
	name: string;
	/** Config scope; extension-discovered servers are not listed. */
	scope: "user" | "project";
	/** stdio, http, or sse. */
	type: string;
	/** Config flag folded with the user-level disabled-servers list. */
	enabled: boolean;
	/** A same-name entry in the other scope shadows this row at load time. */
	shadowed?: true;
	/** Redacted: stdio command, or the remote URL without query/userinfo. */
	location: string | null;
	/** Env var count — values never leave the agent machine. */
	envCount: number;
	args?: string[];
	/** Live section (enabled, non-shadowed, manager-connected rows only). */
	health?: "connected" | "connecting" | "disconnected";
	implementationName?: string;
	implementationVersion?: string;
	instructions?: string;
	tools?: Array<{ name: string; description?: string }>;
	toolsCount?: number;
	resourcesCount?: number;
	promptsCount?: number;
}

/** The session's configured MCP servers: config truth joined with the live session's view. */
export async function getMcpServers(id: string): Promise<McpServerInfo[]> {
	const reply = await api<{ ok: true; servers: McpServerInfo[] }>(`/api/sessions/${encodeURIComponent(id)}/mcp`);
	return reply.servers;
}

/** Add request: stdio (`command`+`args`) or remote (`url`+`transport`, `token` → Authorization header). */
export interface McpAddRequest {
	name: string;
	scope?: "user" | "project";
	url?: string;
	transport?: "http" | "sse";
	token?: string;
	command?: string;
	args?: string[];
}

/** Adds a server to the session's project (default) or user `mcp.json`; applies to new sessions. */
export async function postMcpAdd(id: string, request: McpAddRequest): Promise<{ name: string; scope: string }> {
	const reply = await api<{ ok: true; name: string; scope: string }>(`/api/sessions/${encodeURIComponent(id)}/mcp/add`, {
		method: "POST",
		body: JSON.stringify(request),
	});
	return { name: reply.name, scope: reply.scope };
}

/** Removes a server from the given scope's config file; applies to new sessions. */
export async function postMcpRemove(id: string, name: string, scope: "user" | "project"): Promise<void> {
	await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/mcp/remove`, {
		method: "POST",
		body: JSON.stringify({ name, scope }),
	});
}

/**
 * Enable/disable result; `where` names the file that changed — the project or
 * user config entry, or the user-level disabled-servers list for servers with
 * no writable config entry.
 */
export interface McpEnabledResult {
	name: string;
	enabled: boolean;
	where: "project" | "user" | "disabled-list";
}

/** Enables or disables a server (TUI `/mcp enable|disable` semantics); applies to new sessions. */
export async function postMcpEnabled(id: string, name: string, enabled: boolean): Promise<McpEnabledResult> {
	const reply = await api<{ ok: true } & McpEnabledResult>(`/api/sessions/${encodeURIComponent(id)}/mcp/enabled`, {
		method: "POST",
		body: JSON.stringify({ name, enabled }),
	});
	return { name: reply.name, enabled: reply.enabled, where: reply.where };
}

/** Result of a one-shot test connection to a configured server; the live session is untouched. */
export interface McpTestResult {
	name: string;
	count: number;
	tools: Array<{ name: string; description?: string }>;
}

/** Opens one temporary connection to a configured, enabled server and lists its tools. */
export async function postMcpTest(id: string, name: string): Promise<McpTestResult> {
	const reply = await api<{ ok: true } & McpTestResult>(`/api/sessions/${encodeURIComponent(id)}/mcp/test`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	return { name: reply.name, count: reply.count, tools: reply.tools };
}

/** One browsable child directory of a machine listing (protocol §2 `DirListing`). */
export interface DirEntry {
	name: string;
	path: string;
}

/** Machine directory listing behind the start-form picker (protocol §2 "Machine commands"). */
export interface DirListing {
	path: string;
	parent: string | null;
	entries: DirEntry[];
	truncated: boolean;
}

/**
 * Browsable directory children of `dirPath` on an agent machine; omit `dirPath`
 * to start at the agent user's home. The hub answers 404 (unknown machine),
 * 502 (agent offline), 504 (cmd timed out), 400 (bad path) — all
 * {@link HubApiError}.
 */
export async function listMachineDirectories(machineId: string, dirPath?: string): Promise<DirListing> {
	const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
	const reply = await api<{ ok: true; listing: DirListing }>(
		`/api/machines/${encodeURIComponent(machineId)}/fs${query}`,
	);
	return reply.listing;
}

/**
 * Named omp profiles that exist on a machine, for the start-form picker; the
 * implicit `"default"` profile is never listed and is the client's own empty
 * option. The hub answers 404 (unknown machine), 502 (agent offline), 504 (cmd
 * timed out), 400 (agent-reported error) — all {@link HubApiError}.
 */
export async function listMachineProfiles(machineId: string): Promise<string[]> {
	const reply = await api<{ ok: true; profiles: string[] }>(
		`/api/machines/${encodeURIComponent(machineId)}/profiles`,
	);
	return reply.profiles;
}

/** One resumable omp session on a machine (protocol §2 `SessionListEntry`). */
export interface MachineSession {
	/** Absolute session file path; the value for {@link StartSessionRequest.sessionFile}. */
	path: string;
	id: string;
	cwd: string;
	title?: string;
	created: string;
	modified: string;
	messageCount: number;
	assistantTurns?: number;
	status?: string;
	firstMessage: string;
	/** Named omp profile the session belongs to; absent means the default profile. */
	profile?: string;
}

/** Machine session history behind the resume picker (protocol §2 "Machine commands"). */
export interface SessionListing {
	sessions: MachineSession[];
	truncated: boolean;
}

/**
 * Recent omp sessions on an agent machine across every profile, most recently
 * modified first; entries from named profiles carry {@link MachineSession.profile}.
 * Status codes mirror {@link listMachineDirectories}.
 */
export async function getMachineSessions(machineId: string): Promise<SessionListing> {
	const reply = await api<{ ok: true; listing: SessionListing }>(
		`/api/machines/${encodeURIComponent(machineId)}/sessions`,
	);
	return reply.listing;
}

/**
 * One agent-facing notification recorded on the hub (protocol §3 `Notice`,
 * 0.8.0+): in-memory only — a hub restart drops them.
 */
export interface Notice {
	id: string;
	message: string;
	urgency: "info" | "warn" | "urgent";
	sessionId?: string;
	createdAt: number;
}

/**
 * Deliver a text message to a live session (protocol §3 `POST
 * /api/sessions/:id/prompt`): a new turn when idle, queued as
 * steering/follow-up while one streams. Resolves whether the session accepted
 * it; the hub answers 400 (blank text), 404 (unknown session), 409 (not live),
 * 502 (agent offline), 504 (cmd timed out) — all {@link HubApiError}.
 */
export async function postSessionPrompt(id: string, text: string): Promise<boolean> {
	const reply = await api<{ ok: true; accepted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/prompt`, {
		method: "POST",
		body: JSON.stringify({ text }),
	});
	return reply.accepted;
}

/** Recent hub notices, newest first (protocol §3 `GET /api/notices`, 0.8.0+). */
export async function getNotices(): Promise<Notice[]> {
	return (await api<{ notices: Notice[] }>("/api/notices")).notices;
}

/** One session file's message-text hits (protocol §2 `search-sessions`). */
export interface SessionMessageHit {
	/** Absolute session file path, echoed from the request. */
	path: string;
	/** Matching user/assistant messages in the file. */
	count: number;
	/** Single-line window around the first match. */
	snippet?: string;
}

/**
 * Case-insensitive prompt/assistant text search over session files on one
 * machine (protocol §3 `POST /api/machines/:id/sessions/search`). `paths`
 * defaults to every registry session's file on that machine. Errors mirror
 * {@link getMachineSessions}: 404 unknown machine, 502 offline, 504 timeout,
 * 400 caller-input failures.
 */
export async function searchSessionMessages(machineId: string, query: string, paths?: string[]): Promise<SessionMessageHit[]> {
	const body: { query: string; paths?: string[] } = { query };
	if (paths !== undefined) body.paths = paths;
	const reply = await api<{ ok: true; matches: SessionMessageHit[] }>(
		`/api/machines/${encodeURIComponent(machineId)}/sessions/search`,
		{ method: "POST", body: JSON.stringify(body) },
	);
	return reply.matches;
}

/** Human-readable message for an unknown thrown value. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
