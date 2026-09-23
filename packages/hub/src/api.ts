/**
 * HTTP API (docs/protocol.md §3): machine/session registry for the web UI.
 * Everything except `/api/health` requires `Authorization: Bearer <HUB_TOKEN>`.
 */
import { newCmdReqId, type AgentRegistry, type CmdLoopCondition, type CmdLoopLimit, type CmdName, type CmdRequest } from "./agents";
import { derivePublicBase, type Config } from "./config";
import { normalizeProfileName } from "./profiles";
import type { SessionStore } from "./sessions";

export interface ApiContext {
	readonly cfg: Config;
	readonly sessions: SessionStore;
	readonly agents: AgentRegistry;
}

/** `cmd` parameters, minus the routing fields the hub fills in. */
type CmdParams = Omit<CmdRequest, "id" | "reqId" | "cmd">;

/** Result of the shared `cmd` gate: the agent's payload, or the mapped error reply. */
type CmdOutcome = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly response: Response };

const SESSION_PATH_RE = /^\/api\/sessions\/([^/]+)$/;
const STOP_PATH_RE = /^\/api\/sessions\/([^/]+)\/stop$/;
const AGENT_STATE_PATH_RE = /^\/api\/sessions\/([^/]+)\/agent-state$/;
const CONTEXT_PATH_RE = /^\/api\/sessions\/([^/]+)\/context$/;
const MODEL_PATH_RE = /^\/api\/sessions\/([^/]+)\/model$/;
const THINKING_PATH_RE = /^\/api\/sessions\/([^/]+)\/thinking$/;
const TREE_PATH_RE = /^\/api\/sessions\/([^/]+)\/tree$/;
const COMPACT_PATH_RE = /^\/api\/sessions\/([^/]+)\/compact$/;
const RETRY_PATH_RE = /^\/api\/sessions\/([^/]+)\/retry$/;
const LOOP_PATH_RE = /^\/api\/sessions\/([^/]+)\/loop$/;
const GOAL_PATH_RE = /^\/api\/sessions\/([^/]+)\/goal$/;
const EXTENDED_CONTEXT_PATH_RE = /^\/api\/sessions\/([^/]+)\/extended-context$/;
const MACHINE_FS_PATH_RE = /^\/api\/machines\/([^/]+)\/fs$/;
/** `/api/machines/:id/usage/<dashboard path>`; the rest is relayed verbatim. */
const USAGE_PROXY_PATH_RE = /^\/api\/machines\/([^/]+)\/usage(\/.+)$/;
/** Cap on the caller's POST body relayed to a machine's stats dashboard. */
const MAX_USAGE_BODY_BYTES = 1024 * 1024;
const MACHINE_PROFILES_PATH_RE = /^\/api\/machines\/([^/]+)\/profiles$/;
const MACHINE_SESSIONS_PATH_RE = /^\/api\/machines\/([^/]+)\/sessions$/;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function authorized(req: Request, cfg: Config): boolean {
	const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
	return match !== null && match[1] === cfg.token;
}

function field(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return typeof value === "string" ? value : undefined;
}

/** Parsed JSON object body; null on malformed JSON or a non-object payload. */
async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch {
		return null;
	}
	return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

export async function handleApi(req: Request, ctx: ApiContext): Promise<Response> {
	const pathname = new URL(req.url).pathname;
	const route = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

	if (req.method === "GET" && route === "/api/health") {
		return json({ ok: true, version: ctx.cfg.version });
	}
	if (!authorized(req, ctx.cfg)) return json({ error: "unauthorized" }, 401);

	if (req.method === "GET" && route === "/api/machines") {
		return json({ machines: ctx.agents.listMachines() });
	}
	const machineFs = MACHINE_FS_PATH_RE.exec(route);
	if (machineFs && req.method === "GET") {
		return listMachineFs(decodeURIComponent(machineFs[1]!), req, ctx);
	}
	const machineProfiles = MACHINE_PROFILES_PATH_RE.exec(route);
	if (machineProfiles && req.method === "GET") {
		return listMachineProfiles(decodeURIComponent(machineProfiles[1]!), ctx);
	}
	const machineSessions = MACHINE_SESSIONS_PATH_RE.exec(route);
	if (machineSessions && req.method === "GET") {
		return listMachineSessions(decodeURIComponent(machineSessions[1]!), ctx);
	}
	if (req.method === "GET" && route === "/api/sessions") {
		return json({ sessions: ctx.sessions.list() });
	}
	if (req.method === "POST" && route === "/api/sessions") {
		return createSession(req, ctx);
	}

	const single = SESSION_PATH_RE.exec(route);
	if (single) {
		const id = decodeURIComponent(single[1]!);
		const record = ctx.sessions.get(id);
		if (!record) return json({ error: "session not found" }, 404);
		if (req.method === "GET") return json({ session: record });
	}

	// Matched on the raw pathname: the relayed dashboard path must keep its exact shape.
	const usage = USAGE_PROXY_PATH_RE.exec(pathname);
	if (usage) {
		return usageProxy(decodeURIComponent(usage[1]!), usage[2]!, new URL(req.url).search, req, ctx);
	}

	const stop = STOP_PATH_RE.exec(route);
	if (stop && req.method === "POST") {
		return stopSession(decodeURIComponent(stop[1]!), ctx);
	}

	const state = AGENT_STATE_PATH_RE.exec(route);
	if (state && req.method === "GET") {
		return agentState(decodeURIComponent(state[1]!), ctx);
	}
	const context = CONTEXT_PATH_RE.exec(route);
	if (context && req.method === "GET") {
		return sessionContext(decodeURIComponent(context[1]!), ctx);
	}
	const model = MODEL_PATH_RE.exec(route);
	if (model && req.method === "POST") {
		return setModel(decodeURIComponent(model[1]!), req, ctx);
	}
	const thinking = THINKING_PATH_RE.exec(route);
	if (thinking && req.method === "POST") {
		return setThinking(decodeURIComponent(thinking[1]!), req, ctx);
	}
	const tree = TREE_PATH_RE.exec(route);
	if (tree && req.method === "POST") {
		return navigateTree(decodeURIComponent(tree[1]!), req, ctx);
	}
	const compact = COMPACT_PATH_RE.exec(route);
	if (compact && req.method === "POST") {
		return compactSession(decodeURIComponent(compact[1]!), req, ctx);
	}
	const retry = RETRY_PATH_RE.exec(route);
	if (retry && req.method === "POST") {
		return retrySession(decodeURIComponent(retry[1]!), ctx);
	}
	const loop = LOOP_PATH_RE.exec(route);
	if (loop && req.method === "POST") {
		return sessionLoop(decodeURIComponent(loop[1]!), req, ctx);
	}
	const goal = GOAL_PATH_RE.exec(route);
	if (goal && req.method === "POST") {
		return sessionGoal(decodeURIComponent(goal[1]!), req, ctx);
	}
	const extendedContext = EXTENDED_CONTEXT_PATH_RE.exec(route);
	if (extendedContext && req.method === "POST") {
		return setExtendedContext(decodeURIComponent(extendedContext[1]!), req, ctx);
	}

	return json({ error: "not found" }, 404);
}

async function createSession(req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);

	const machineId = field(body, "machineId");
	if (!machineId) return json({ error: "machineId is required" }, 400);
	const cwd = field(body, "cwd");
	if (!cwd || cwd.trim() === "") return json({ error: "cwd is required" }, 400);

	// Reject bad names before a record exists; whether the profile exists at all
	// is machine-local knowledge, checked by the agent at spawn (§2).
	let profile: string | undefined;
	try {
		profile = normalizeProfileName(field(body, "profile"));
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}

	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!machine.connected) return json({ error: "machine offline" }, 404);

	// Optional resume target: present-but-empty is a caller bug, not "start
	// fresh" — silently degrading a resume click into a blank session would
	// look like lost history.
	const rawSessionFile = body.sessionFile;
	if (rawSessionFile !== undefined && (typeof rawSessionFile !== "string" || rawSessionFile.trim() === "")) {
		return json({ error: "sessionFile must be a non-empty string" }, 400);
	}
	const sessionFile = typeof rawSessionFile === "string" ? rawSessionFile.trim() : undefined;

	const record = ctx.sessions.create({
		machineId,
		machineName: machine.name,
		cwd,
		name: field(body, "name"),
		profile,
	});
	const prompt = field(body, "prompt");
	const base = derivePublicBase(req, ctx.cfg);
	const dispatched = ctx.agents.send(machineId, {
		t: "start",
		id: record.id,
		cwd: record.cwd,
		name: record.name,
		...(prompt === undefined ? {} : { prompt }),
		...(profile === undefined ? {} : { profile }),
		...(sessionFile === undefined ? {} : { sessionFile }),
		relayUrl: base.wsBase,
		webUrl: base.httpBase,
	});
	if (!dispatched) {
		ctx.sessions.delete(record.id);
		return json({ error: "machine write failed" }, 502);
	}
	return json({ session: record }, 202);
}

function stopSession(id: string, ctx: ApiContext): Response {
	const record = ctx.sessions.get(id);
	if (!record) return json({ error: "session not found" }, 404);
	if (record.status === "exited" || record.status === "failed") {
		return json({ error: "session already finished" }, 409);
	}
	// Best effort: the record flips when the agent reports session-exit.
	ctx.agents.send(record.machineId, { t: "stop", id: record.id, reason: "user stop" });
	return json({ ok: true });
}

/**
 * Machine-level directory listing for the start-form picker: forwards
 * `list-dir` to the connected agent (protocol §2 "Machine commands"). 404
 * unknown machine, 502 agent offline, 504 cmd timeout, mapped status for
 * agent-reported path errors.
 */
async function listMachineFs(machineId: string, req: Request, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!ctx.agents.isOnline(machineId)) return json({ error: "agent offline" }, 502);

	const dirPath = new URL(req.url).searchParams.get("path") ?? undefined;
	const result = await ctx.agents.sendCmd(machineId, {
		reqId: newCmdReqId(),
		cmd: "list-dir",
		...(dirPath ? { path: dirPath } : {}),
	});
	if (!result.ok) return json({ error: result.error }, cmdErrorStatus(result.error));
	return json({ ok: true, listing: result.data });
}

/**
 * Machine-level usage relay (protocol §3): forwards `<method> <path><query>`
 * to the machine's local omp stats dashboard over a `usage-req` frame and
 * replays the agent's `usage-res` verbatim. Reads like any other `/api/*`
 * caller — bearer-authenticated, JSON errors on the tunnel's own failures.
 */
async function usageProxy(machineId: string, rest: string, search: string, req: Request, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
		return json({ error: "method not allowed" }, 405);
	}
	if (!machine.connected || !ctx.agents.isOnline(machineId)) return json({ error: "machine offline" }, 502);

	let bodyB64: string | undefined;
	if (req.method === "POST") {
		const body = new Uint8Array(await req.arrayBuffer());
		if (body.byteLength > MAX_USAGE_BODY_BYTES) return json({ error: "request body too large" }, 413);
		bodyB64 = body.byteLength > 0 ? Buffer.from(body).toString("base64") : undefined;
	}

	const result = await ctx.agents.sendUsageRequest(machineId, req.method, `${rest}${search}`, bodyB64);
	// Relay failures are gateway-shaped: agent-reported or transport errors are
	// 502; only the hub's own timeout is 504.
	if (!result.ok) return json({ error: result.error }, result.error === "usage timeout" ? 504 : 502);

	const rawStatus = pick(result.data, "status");
	const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
		? rawStatus
		: undefined;
	if (status === undefined) return json({ error: "invalid usage response" }, 502);
	const contentType = pick(result.data, "contentType");
	const bodyB64Reply = pick(result.data, "bodyB64");
	const body = typeof bodyB64Reply === "string" ? Buffer.from(bodyB64Reply, "base64") : undefined;
	return new Response(body ?? undefined, {
		status,
		headers: typeof contentType === "string" ? { "content-type": contentType } : {},
	});
}

/**
 * Named omp profiles on a machine for the start-form picker: forwards
 * `list-profiles` to the connected agent (protocol §2 "Machine commands").
 * 404 unknown machine, 502 agent offline, 504 cmd timeout, mapped status for
 * agent-reported errors.
 */
async function listMachineProfiles(machineId: string, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!ctx.agents.isOnline(machineId)) return json({ error: "agent offline" }, 502);

	const result = await ctx.agents.sendCmd(machineId, { reqId: newCmdReqId(), cmd: "list-profiles" });
	if (!result.ok) return json({ error: result.error }, cmdErrorStatus(result.error));
	const profiles = pick(result.data, "profiles");
	return json({ ok: true, profiles: Array.isArray(profiles) ? profiles : [] });
}

/**
 * Machine-level session history for the resume picker: forwards
 * `list-sessions` with `allProfiles` so the listing merges the default profile
 * with every named omp profile, each entry stamped with its owning profile
 * (protocol §2 "Machine commands"). Status codes mirror `listMachineFs`.
 */
async function listMachineSessions(machineId: string, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!ctx.agents.isOnline(machineId)) return json({ error: "agent offline" }, 502);

	const result = await ctx.agents.sendCmd(machineId, {
		reqId: newCmdReqId(),
		cmd: "list-sessions",
		allProfiles: true,
	});
	if (!result.ok) return json({ error: result.error }, cmdErrorStatus(result.error));
	return json({ ok: true, listing: result.data });
}

async function agentState(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "get-state", {}, ctx);
	return outcome.ok ? json({ ok: true, state: outcome.data }) : outcome.response;
}

/** `get-context` takes no parameters: the agent reports its own token estimates (protocol §2). */
async function sessionContext(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "get-context", {}, ctx);
	return outcome.ok ? json({ ok: true, context: outcome.data }) : outcome.response;
}

async function setModel(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const provider = field(body, "provider");
	if (!provider || provider.trim() === "") return json({ error: "provider is required" }, 400);
	const modelId = field(body, "modelId");
	if (!modelId || modelId.trim() === "") return json({ error: "modelId is required" }, 400);
	const role = field(body, "role");
	if (role !== undefined && (role.trim() === "" || role.length > 64)) {
		return json({ error: "invalid role" }, 400);
	}
	const persist = body["persist"];
	if (persist !== undefined && typeof persist !== "boolean") {
		return json({ error: "persist must be a boolean" }, 400);
	}
	const level = field(body, "level");
	if (level !== undefined && level.trim() === "") {
		return json({ error: "invalid level" }, 400);
	}

	const outcome = await dispatchCmd(id, "set-model", {
		provider,
		modelId,
		...(role === undefined ? {} : { role }),
		...(typeof persist === "boolean" ? { persist } : {}),
		...(level === undefined ? {} : { level }),
	}, ctx);
	// `role` echoes the agent's answer; the fallbacks cover an older agent that
	// predates role support (and `thinkingLevel` an older agent without level
	// support on `set-model`).
	return outcome.ok
		? json({
				ok: true,
				switched: pick(outcome.data, "switched"),
				role: pick(outcome.data, "role") ?? role ?? "default",
				thinkingLevel: pick(outcome.data, "thinkingLevel") ?? null,
			})
		: outcome.response;
}

async function setThinking(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const level = field(body, "level");
	if (!level || level.trim() === "") return json({ error: "level is required" }, 400);

	const outcome = await dispatchCmd(id, "set-thinking", { level }, ctx);
	return outcome.ok ? json({ ok: true, thinkingLevel: pick(outcome.data, "thinkingLevel") }) : outcome.response;
}

/**
 * Move the session's tree leaf (rewind): the target entry and everything after
 * it leaves the active branch; a user-message target also rewinds past itself
 * and returns its text as `editorText`. The host broadcasts no tree-change
 * frame, so the caller rebuilds its transcript locally on success.
 */
async function navigateTree(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const entryId = field(body, "entryId");
	if (!entryId || entryId.trim() === "") return json({ error: "entryId is required" }, 400);
	const summarize = body["summarize"];
	if (summarize !== undefined && typeof summarize !== "boolean") {
		return json({ error: "summarize must be a boolean" }, 400);
	}

	const outcome = await dispatchCmd(id, "navigate-tree", {
		entryId,
		...(typeof summarize === "boolean" ? { summarize } : {}),
	}, ctx);
	if (!outcome.ok) return outcome.response;
	const data = outcome.data as Record<string, unknown>;
	return json({
		ok: true,
		cancelled: pick(data, "cancelled") ?? false,
		aborted: pick(data, "aborted") ?? false,
		editorText: pick(data, "editorText") ?? null,
		leafId: pick(data, "leafId") ?? null,
	});
}

/**
 * Compaction is a long-running model call: the agent dispatches it in the
 * background and answers immediately, so this only confirms the dispatch —
 * progress streams through the transcript (contract §1).
 */
async function compactSession(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const instructions = body["instructions"];
	if (instructions !== undefined && typeof instructions !== "string") {
		return json({ error: "instructions must be a string" }, 400);
	}
	const mode = body["mode"];
	if (mode !== undefined && typeof mode !== "string") return json({ error: "mode must be a string" }, 400);

	const outcome = await dispatchCmd(id, "compact", {
		...(typeof instructions === "string" ? { instructions } : {}),
		...(typeof mode === "string" ? { mode } : {}),
	}, ctx);
	return outcome.ok ? json({ ok: true }) : outcome.response;
}

/**
 * Retry the last failed turn. `session.retry()` reports `started: false` when
 * there is nothing to retry (contract §1) — the same 409 the agent's explicit
 * errors map to below.
 */
async function retrySession(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "retry", {}, ctx);
	if (!outcome.ok) return outcome.response;
	if (pick(outcome.data, "started") !== true) return json({ error: "Nothing to retry." }, 409);
	return json({ ok: true, started: true });
}

const LOOP_ACTIONS: Record<string, true> = { enable: true, disable: true, pause: true, resume: true, status: true };

/** Type guard for the `loop` limiter: exactly one positive `iterations` or `durationMs`. */
function isLoopLimit(value: unknown): value is CmdLoopLimit {
	if (value === null || typeof value !== "object") return false;
	const { iterations, durationMs } = value as Record<string, unknown>;
	const positive = (candidate: unknown): boolean =>
		typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0;
	if (positive(iterations)) return durationMs === undefined;
	return positive(durationMs) && iterations === undefined;
}

/** Type guard for the `loop` condition: a non-blank command plus a boolean polarity. */
function isLoopCondition(value: unknown): value is CmdLoopCondition {
	if (value === null || typeof value !== "object") return false;
	const { command, until } = value as Record<string, unknown>;
	return typeof command === "string" && command.trim() !== "" && typeof until === "boolean";
}

/**
 * Drive the session loop engine (contract §1/§2): enable/disable/pause/resume,
 * or read its status. The loop status echoes back so the caller can refresh
 * its state card without a second `get-state`.
 */
async function sessionLoop(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const action = field(body, "action");
	if (!action || LOOP_ACTIONS[action] !== true) {
		return json({ error: "action must be one of enable, disable, pause, resume, status" }, 400);
	}
	const prompt = field(body, "prompt");
	if (prompt !== undefined && prompt.trim() === "") return json({ error: "invalid prompt" }, 400);
	const limit: unknown = body["limit"];
	if (limit !== undefined && !isLoopLimit(limit)) return json({ error: "invalid limit" }, 400);
	const condition: unknown = body["condition"];
	if (condition !== undefined && !isLoopCondition(condition)) return json({ error: "invalid condition" }, 400);

	const outcome = await dispatchCmd(id, "loop", {
		action,
		...(prompt === undefined ? {} : { prompt }),
		...(limit === undefined ? {} : { limit }),
		...(condition === undefined ? {} : { condition }),
	}, ctx);
	return outcome.ok ? json({ ok: true, loop: pick(outcome.data, "loop") ?? null }) : outcome.response;
}

const GOAL_ACTIONS: Record<string, true> = { set: true, replace: true, pause: true, resume: true, drop: true, budget: true };

/**
 * Drive the session's goal runtime (contract §1): set/replace/pause/resume/
 * drop the objective or set a token budget. SDK-side failures (missing budget
 * number, unknown objective state) bubble through the cmd-result mapping.
 */
async function sessionGoal(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const action = field(body, "action");
	if (!action || GOAL_ACTIONS[action] !== true) {
		return json({ error: "action must be one of set, replace, pause, resume, drop, budget" }, 400);
	}
	const objective = field(body, "objective");
	if (objective !== undefined && objective.trim() === "") return json({ error: "invalid objective" }, 400);
	if ((action === "set" || action === "replace") && (objective ?? "").trim() === "") {
		return json({ error: "objective is required" }, 400);
	}
	const tokenBudget = body["tokenBudget"];
	if (tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isFinite(tokenBudget) || tokenBudget < 0)) {
		return json({ error: "tokenBudget must be a non-negative number" }, 400);
	}

	const outcome = await dispatchCmd(id, "goal", {
		action,
		...(objective === undefined ? {} : { objective }),
		...(typeof tokenBudget === "number" ? { tokenBudget } : {}),
	}, ctx);
	return outcome.ok ? json({ ok: true, goal: pick(outcome.data, "goal") ?? null }) : outcome.response;
}

/**
 * Toggle (or set) the session's extended-context setting (contract §1);
 * `enabled` omitted flips the current state on the agent.
 */
async function setExtendedContext(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const enabled = body["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return json({ error: "enabled must be a boolean" }, 400);
	}

	const outcome = await dispatchCmd(id, "set-extended-context", {
		...(typeof enabled === "boolean" ? { enabled } : {}),
	}, ctx);
	return outcome.ok ? json({ ok: true, extendedContext: pick(outcome.data, "extendedContext") ?? false }) : outcome.response;
}

/**
 * Streams one `cmd` to the owning agent: 404 unknown session, 409 unless `live`,
 * 502 agent offline, 504 agent silent past `cmdTimeoutMs`, 500 anything else.
 */
async function dispatchCmd(id: string, cmd: CmdName, params: CmdParams, ctx: ApiContext): Promise<CmdOutcome> {
	const record = ctx.sessions.get(id);
	if (!record) return { ok: false, response: json({ error: "session not found" }, 404) };
	if (record.status !== "live") return { ok: false, response: json({ error: `session is ${record.status}` }, 409) };
	if (!ctx.agents.isOnline(record.machineId)) return { ok: false, response: json({ error: "agent offline" }, 502) };

	const result = await ctx.agents.sendCmd(record.machineId, { id: record.id, reqId: newCmdReqId(), cmd, ...params });
	if (!result.ok) return { ok: false, response: json({ error: result.error }, cmdErrorStatus(result.error)) };
	return { ok: true, data: result.data };
}

/** HTTP status for an agent-reported failure (protocol §3 session-command rows). */
function cmdErrorStatus(error: string): number {
	// `retry` state conflicts (contract §1): nothing left to replay, or a turn
	// still streaming — the agent's own message tells the caller which.
	if (error === "Nothing to retry." || error.startsWith("Wait for the current response")) return 409;
	switch (error) {
		case "unknown session":
			return 409;
		case "no such directory":
		case "not a directory":
		case "permission denied": // list-dir caller-input failures (protocol §2 "Machine commands")
			return 400;
		case "agent offline":
		case "agent disconnected": // the socket died mid-command: just as offline to the caller
			return 502;
		case "cmd timeout":
			return 504;
		default:
			return 500;
	}
}

/** Nested field of the agent's `data` payload; undefined when the payload is malformed. */
function pick(data: unknown, key: string): unknown {
	if (data === null || typeof data !== "object") return undefined;
	return (data as Record<string, unknown>)[key];
}
