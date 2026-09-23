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
	status: SessionStatus;
	startedAt: number;
	exitedAt?: number;
	exitReason?: string;
	error?: string;
	links?: SessionLinks;
	sessionFile?: string;
	pid?: number;
}

export interface MachineRecord {
	machineId: string;
	name: string;
	connected: boolean;
	connectedAt: number;
	sessionCount: number;
}

export interface StartSessionRequest {
	machineId: string;
	cwd: string;
	name?: string;
	prompt?: string;
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
	headers.set("Authorization", `Bearer ${getToken() ?? ""}`);
	if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	const res = await fetch(path, { ...init, headers });
	if (!res.ok) throw new HubApiError(res.status, await errorMessage(res));
	return (await res.json()) as T;
}

export async function getMachines(): Promise<MachineRecord[]> {
	return (await api<{ machines: MachineRecord[] }>("/api/machines")).machines;
}

/** Time ranges the machine's stats dashboard accepts (protocol §3 usage relay). */
export type UsageRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

/** Aggregated usage counters (machine dashboard `AggregatedStats`, subset we render). */
export interface UsageAggregate {
	totalRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
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
 * dashboard (protocol §3 usage relay). The hub answers 404 (unknown machine),
 * 502 (machine offline or dashboard unavailable), 504 (relay timeout) — all
 * {@link HubApiError}.
 */
export async function getMachineUsage(machineId: string, range: UsageRange): Promise<MachineUsageStats> {
	return api<MachineUsageStats>(
		`/api/machines/${encodeURIComponent(machineId)}/usage/api/stats?range=${encodeURIComponent(range)}`,
	);
}

/** Triggers the machine's incremental session scan and returns its counts. */
export async function syncMachineUsage(
	machineId: string,
): Promise<{ processed: number; files: number; totalMessages: number }> {
	return api(`/api/machines/${encodeURIComponent(machineId)}/usage/api/sync`, { method: "POST" });
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
	const reply = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
	return reply.session;
}

export async function stopSession(id: string): Promise<void> {
	await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
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

/** Set the session thinking level; resolves the effective level after the set. */
export async function setThinking(id: string, level: string): Promise<{ thinkingLevel: string }> {
	const reply = await api<{ ok: true; thinkingLevel: string }>(`/api/sessions/${encodeURIComponent(id)}/thinking`, {
		method: "POST",
		body: JSON.stringify({ level }),
	});
	return { thinkingLevel: reply.thinkingLevel };
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

/** Human-readable message for an unknown thrown value. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
