/**
 * HTTP API (docs/protocol.md §3): machine/session registry for the web UI.
 * Everything except `/api/health` requires `Authorization: Bearer <HUB_TOKEN>`.
 */
import { newCmdReqId, supportsFleetNamespace, supportsFleetSqlQuery, supportsRecentFleetMessages, versionTriple, type AgentRegistry, type CmdLoopCondition, type CmdLoopLimit, type CmdName, type CmdRequest } from "./agents";
import { derivePublicBase, type Config } from "./config";
import { FleetMoveInProgressError, type FleetEvent, type FleetState } from "./fleet-state";
import { getFleetMessageContext, searchFleetNamespace, searchFleetSession } from "./fleet-search";
import { log } from "./log";
import { normalizeProfileName } from "./profiles";
import { isTerminalStatus, randomId, type SessionRecord, type SessionStore } from "./sessions";
import type { NoticeStore } from "./notices";

export interface ApiContext {
	readonly cfg: Config;
	readonly sessions: SessionStore;
	readonly agents: AgentRegistry;
	readonly fleet: FleetState;
	readonly notices: NoticeStore;
	/** Set by the bound hub; absent in library/tests. Invoked before the reply returns. */
	readonly restart?: () => void;
}

/** `cmd` parameters, minus the routing fields the hub fills in. */
type CmdParams = Omit<CmdRequest, "id" | "reqId" | "cmd">;

/** Result of the shared `cmd` gate: the agent's payload, or the mapped error reply. */
type CmdOutcome = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly response: Response };

const SESSION_PATH_RE = /^\/api\/sessions\/([^/]+)$/;
const STOP_PATH_RE = /^\/api\/sessions\/([^/]+)\/stop$/;
/** Same-id restart of a terminal session (protocol §3). */
const RESTART_PATH_RE = /^\/api\/sessions\/([^/]+)\/restart$/;
const AGENT_STATE_PATH_RE = /^\/api\/sessions\/([^/]+)\/agent-state$/;
const CONTEXT_PATH_RE = /^\/api\/sessions\/([^/]+)\/context$/;
const MODEL_PATH_RE = /^\/api\/sessions\/([^/]+)\/model$/;
const THINKING_PATH_RE = /^\/api\/sessions\/([^/]+)\/thinking$/;
const TREE_PATH_RE = /^\/api\/sessions\/([^/]+)\/tree$/;
const COMPACT_PATH_RE = /^\/api\/sessions\/([^/]+)\/compact$/;
const SHAKE_PATH_RE = /^\/api\/sessions\/([^/]+)\/shake$/;
const HANDOFF_PATH_RE = /^\/api\/sessions\/([^/]+)\/handoff$/;
const RETRY_PATH_RE = /^\/api\/sessions\/([^/]+)\/retry$/;
const LOOP_PATH_RE = /^\/api\/sessions\/([^/]+)\/loop$/;
const GOAL_PATH_RE = /^\/api\/sessions\/([^/]+)\/goal$/;
const EXTENDED_CONTEXT_PATH_RE = /^\/api\/sessions\/([^/]+)\/extended-context$/;
const CLEAR_CONTEXT_PATH_RE = /^\/api\/sessions\/([^/]+)\/clear-context$/;
const RENAME_PATH_RE = /^\/api\/sessions\/([^/]+)\/rename$/;
const TITLE_PATH_RE = /^\/api\/sessions\/([^/]+)\/title$/;
const FILES_PATH_RE = /^\/api\/sessions\/([^/]+)\/files$/;
/** MCP management (protocol §2 `mcp-*`): one GET listing plus four POST verbs. */
const MCP_LIST_PATH_RE = /^\/api\/sessions\/([^/]+)\/mcp$/;
const MCP_ADD_PATH_RE = /^\/api\/sessions\/([^/]+)\/mcp\/add$/;
const MCP_REMOVE_PATH_RE = /^\/api\/sessions\/([^/]+)\/mcp\/remove$/;
const MCP_ENABLED_PATH_RE = /^\/api\/sessions\/([^/]+)\/mcp\/enabled$/;
const MCP_TEST_PATH_RE = /^\/api\/sessions\/([^/]+)\/mcp\/test$/;
const PROMPT_PATH_RE = /^\/api\/sessions\/([^/]+)\/prompt$/;
const SESSION_NAMESPACE_PATH_RE = /^\/api\/sessions\/([^/]+)\/namespace$/;
/** Advanced session modes (protocol §3, 0.9.0+). */
const PREWALK_PATH_RE = /^\/api\/sessions\/([^/]+)\/prewalk$/;
const PLAN_PATH_RE = /^\/api\/sessions\/([^/]+)\/plan$/;
const ADVISOR_PATH_RE = /^\/api\/sessions\/([^/]+)\/advisor$/;
const TIER_PATH_RE = /^\/api\/sessions\/([^/]+)\/tier$/;
const PAUSE_PATH_RE = /^\/api\/sessions\/([^/]+)\/pause$/;
const CYCLE_PATH_RE = /^\/api\/sessions\/([^/]+)\/cycle$/;
const SETTINGS_PATH_RE = /^\/api\/sessions\/([^/]+)\/settings$/;
/** Cap on one upload's raw bytes — the cmd round trip must stay inside the 15 s budget. */
const MAX_UPLOAD_BODY_BYTES = 15 * 1024 * 1024;
const MAX_FILENAME_CHARS = 200;
const MACHINE_FS_PATH_RE = /^\/api\/machines\/([^/]+)\/fs$/;
/** `/api/machines/:id/usage/<dashboard path>`; the rest is relayed verbatim. */
const USAGE_PROXY_PATH_RE = /^\/api\/machines\/([^/]+)\/usage(\/.+)$/;
/** Cap on the caller's POST body relayed to a machine's stats dashboard. */
const MAX_USAGE_BODY_BYTES = 1024 * 1024;
const MACHINE_PROFILES_PATH_RE = /^\/api\/machines\/([^/]+)\/profiles$/;
const MACHINE_SUBSCRIPTIONS_PATH_RE = /^\/api\/machines\/([^/]+)\/subscriptions$/;
const MACHINE_SESSIONS_PATH_RE = /^\/api\/machines\/([^/]+)\/sessions$/;
/** Panel-triggered daemon upgrade restart (protocol §3). */
const MACHINE_RESTART_PATH_RE = /^\/api\/machines\/([^/]+)\/restart-daemon$/;
/** Message-text search over session files (protocol §2 `search-sessions`). */
const MACHINE_SESSION_SEARCH_PATH_RE = /^\/api\/machines\/([^/]+)\/sessions\/search$/;
/** Cap on `search-sessions` paths per request, mirroring the agent's own cap. */
const MAX_SEARCH_PATHS = 200;
const MAX_SEARCH_QUERY_CHARS = 256;


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
	if (route === "/api/namespaces") {
		try {
			if (req.method === "GET") return json({ namespaces: ctx.fleet.listNamespaces() });
			if (req.method === "POST") return await createNamespace(req, ctx);
		} catch (err) {
			return fleetStateFailure(err);
		}
	}
	const membership = SESSION_NAMESPACE_PATH_RE.exec(route);
	if (membership && req.method === "PUT") {
		try {
			return await assignNamespace(decodeURIComponent(membership[1]!), req, ctx);
		} catch (err) {
			return fleetStateFailure(err);
		}
	}
	if (route.startsWith("/api/fleet/")) {
		try {
			return await handleFleetApi(route, req, ctx);
		} catch (err) {
			return fleetStateFailure(err);
		}
	}
	if (req.method === "GET" && route === "/api/machines") {
		return json({ machines: ctx.agents.listMachines() });
	}
	if (req.method === "POST" && route === "/api/hub/restart") {
		// Upgrade restart (protocol §3): flush the snapshot, spawn a fresh hub
		// process that waits for the port, answer, then release. `restart` is
		// wired only by the real entry — the library keeps it unset.
		if (ctx.restart === undefined) return json({ error: "restart is not available" }, 501);
		ctx.restart();
		return json({ ok: true });
	}
	const machineFs = MACHINE_FS_PATH_RE.exec(route);
	if (machineFs && req.method === "GET") {
		return listMachineFs(decodeURIComponent(machineFs[1]!), req, ctx);
	}
	const machineProfiles = MACHINE_PROFILES_PATH_RE.exec(route);
	if (machineProfiles && req.method === "GET") {
		return listMachineProfiles(decodeURIComponent(machineProfiles[1]!), ctx);
	}
	const machineSubscriptions = MACHINE_SUBSCRIPTIONS_PATH_RE.exec(route);
	if (machineSubscriptions && req.method === "GET") {
		return machineSubscriptionUsage(decodeURIComponent(machineSubscriptions[1]!), req, ctx);
	}
	const machineSessions = MACHINE_SESSIONS_PATH_RE.exec(route);
	if (machineSessions && req.method === "GET") {
		return listMachineSessions(decodeURIComponent(machineSessions[1]!), ctx);
	}
	const machineRestart = MACHINE_RESTART_PATH_RE.exec(route);
	if (machineRestart && req.method === "POST") {
		return restartMachineDaemon(decodeURIComponent(machineRestart[1]!), ctx);
	}
	const machineSessionSearch = MACHINE_SESSION_SEARCH_PATH_RE.exec(route);
	if (machineSessionSearch && req.method === "POST") {
		return searchMachineSessions(decodeURIComponent(machineSessionSearch[1]!), req, ctx);
	}
	if (req.method === "GET" && route === "/api/sessions") {
		return json({ sessions: ctx.sessions.list() });
	}
	if (req.method === "POST" && route === "/api/sessions") {
		return createSession(req, ctx);
	}
	if (req.method === "POST" && route === "/api/notices") {
		return createNotice(req, ctx);
	}
	if (req.method === "GET" && route === "/api/notices") {
		return json({ notices: ctx.notices.list() });
	}

	const single = SESSION_PATH_RE.exec(route);
	if (single) {
		const id = decodeURIComponent(single[1]!);
		const record = ctx.sessions.get(id);
		if (!record) return json({ error: "session not found" }, 404);
		if (req.method === "GET") return json({ session: record });
		if (req.method === "DELETE") return deleteSession(id, ctx);
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

	const restart = RESTART_PATH_RE.exec(route);
	if (restart && req.method === "POST") {
		return restartSession(decodeURIComponent(restart[1]!), req, ctx);
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
	if (tree && req.method === "GET") {
		return sessionTree(decodeURIComponent(tree[1]!), ctx);
	}
	if (tree && req.method === "POST") {
		return navigateTree(decodeURIComponent(tree[1]!), req, ctx);
	}
	const compact = COMPACT_PATH_RE.exec(route);
	if (compact && req.method === "POST") {
		return compactSession(decodeURIComponent(compact[1]!), req, ctx);
	}
	const shake = SHAKE_PATH_RE.exec(route);
	if (shake && req.method === "POST") {
		return shakeSession(decodeURIComponent(shake[1]!), req, ctx);
	}
	const handoff = HANDOFF_PATH_RE.exec(route);
	if (handoff && req.method === "POST") {
		return handoffSession(decodeURIComponent(handoff[1]!), req, ctx);
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
	const clearContext = CLEAR_CONTEXT_PATH_RE.exec(route);
	if (clearContext && req.method === "POST") {
		return clearSessionContext(decodeURIComponent(clearContext[1]!), ctx);
	}
	const rename = RENAME_PATH_RE.exec(route);
	if (rename && req.method === "POST") {
		return renameSession(decodeURIComponent(rename[1]!), req, ctx);
	}
	const title = TITLE_PATH_RE.exec(route);
	if (title && req.method === "POST") {
		return generateSessionTitle(decodeURIComponent(title[1]!), ctx);
	}
	const files = FILES_PATH_RE.exec(route);
	if (files && req.method === "POST") {
		return uploadSessionFile(decodeURIComponent(files[1]!), req, ctx);
	}
	const prompt = PROMPT_PATH_RE.exec(route);
	if (prompt && req.method === "POST") {
		return promptSession(decodeURIComponent(prompt[1]!), req, ctx);
	}
	const prewalk = PREWALK_PATH_RE.exec(route);
	if (prewalk && req.method === "POST") {
		return sessionPrewalk(decodeURIComponent(prewalk[1]!), req, ctx);
	}
	const plan = PLAN_PATH_RE.exec(route);
	if (plan && req.method === "POST") {
		return sessionPlan(decodeURIComponent(plan[1]!), req, ctx);
	}
	const advisor = ADVISOR_PATH_RE.exec(route);
	if (advisor && req.method === "POST") {
		return sessionAdvisor(decodeURIComponent(advisor[1]!), req, ctx);
	}
	const tier = TIER_PATH_RE.exec(route);
	if (tier && req.method === "POST") {
		return sessionTier(decodeURIComponent(tier[1]!), req, ctx);
	}
	const pause = PAUSE_PATH_RE.exec(route);
	if (pause && req.method === "POST") {
		return sessionPause(decodeURIComponent(pause[1]!), req, ctx);
	}
	const cycle = CYCLE_PATH_RE.exec(route);
	if (cycle && req.method === "POST") {
		return sessionCycle(decodeURIComponent(cycle[1]!), req, ctx);
	}
	const settings = SETTINGS_PATH_RE.exec(route);
	if (settings && req.method === "GET") {
		return sessionSettings(decodeURIComponent(settings[1]!), ctx);
	}
	if (settings && req.method === "POST") {
		return setSessionSetting(decodeURIComponent(settings[1]!), req, ctx);
	}

	const mcpList = MCP_LIST_PATH_RE.exec(route);
	if (mcpList && req.method === "GET") {
		return listMcpServers(decodeURIComponent(mcpList[1]!), ctx);
	}
	const mcpAdd = MCP_ADD_PATH_RE.exec(route);
	if (mcpAdd && req.method === "POST") {
		return addMcpServer(decodeURIComponent(mcpAdd[1]!), req, ctx);
	}
	const mcpRemove = MCP_REMOVE_PATH_RE.exec(route);
	if (mcpRemove && req.method === "POST") {
		return removeMcpServer(decodeURIComponent(mcpRemove[1]!), req, ctx);
	}
	const mcpEnabled = MCP_ENABLED_PATH_RE.exec(route);
	if (mcpEnabled && req.method === "POST") {
		return setMcpServerEnabled(decodeURIComponent(mcpEnabled[1]!), req, ctx);
	}
	const mcpTest = MCP_TEST_PATH_RE.exec(route);
	if (mcpTest && req.method === "POST") {
		return testMcpServer(decodeURIComponent(mcpTest[1]!), req, ctx);
	}

	return json({ error: "not found" }, 404);
}

/** Keep SQLite/transport failures opaque to callers while retaining a diagnostic. */
function fleetStateFailure(err: unknown): Response {
	if (err instanceof FleetMoveInProgressError) return json({ error: err.message }, 409);
	log.error(`fleet state unavailable: ${err instanceof Error ? err.message : String(err)}`);
	return json({ error: "fleet state unavailable" }, 503);
}

/** Namespace administration is root-token-only; it is never reachable through the fleet proxy. */
async function createNamespace(req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (!body) return json({ error: "invalid json body" }, 400);
	const name = field(body, "name")?.trim();
	if (!name || name.length > 100) return json({ error: "name must be 1–100 characters" }, 400);
	if (ctx.fleet.listNamespaces().some(entry => entry.name.toLowerCase() === name.toLowerCase())) {
		return json({ error: "namespace already exists" }, 409);
	}
	const rawMachines = body.machineIds;
	if (rawMachines !== undefined && rawMachines !== null &&
		(!Array.isArray(rawMachines) || rawMachines.some(id => typeof id !== "string" || !ctx.agents.getMachine(id)))) {
		return json({ error: "machineIds must contain known machine ids" }, 400);
	}
	const machineIds = Array.isArray(rawMachines) ? [...new Set(rawMachines as string[])] : null;
	return json({ namespace: ctx.fleet.createNamespace(name, machineIds) }, 201);
}

/** A notification write failure must not turn an already-committed move/start into a false HTTP failure. */
function notifyOrEscalate(ownerId: string, event: FleetEvent, ctx: ApiContext): void {
	try {
		if (ctx.fleet.enqueueFor(ownerId, event)) ctx.agents.notifyFleet(ownerId, event);
	} catch (err) {
		log.error(`fleet notification ${event.id} failed: ${err instanceof Error ? err.message : String(err)}`);
		ctx.notices.add({ message: `Fleet event for session ${event.sessionId} could not be queued; inspect the hub state store.`,
			urgency: "warn", sessionId: event.sessionId });
	}
}

/** A newly visible worker wakes operators so they can claim/watch it. */
function announceAttachedWorker(worker: SessionRecord, ctx: ApiContext): void {
	if (!worker.namespaceId || worker.superagent) return;
	for (const operator of ctx.sessions.list()) {
		if (operator.superagent !== true || operator.status !== "live" || operator.namespaceId !== worker.namespaceId) continue;
		const event = { id: randomId("e_"), sessionId: worker.id, kind: "session_attached", createdAt: Date.now() };
		notifyOrEscalate(operator.id, event, ctx);
	}
}

/** A move revokes access, watches and the current controller in one durable transaction. */
async function assignNamespace(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const record = ctx.sessions.get(id);
	if (!record) return json({ error: "session not found" }, 404);
	const body = await jsonBody(req);
	if (!body || !("namespaceId" in body)) return json({ error: "namespaceId is required (null detaches)" }, 400);
	const namespaceId = body.namespaceId;
	if (namespaceId !== null && (typeof namespaceId !== "string" || !ctx.fleet.getNamespace(namespaceId))) {
		return json({ error: "namespace not found" }, 404);
	}
	const expected = body.expectedVersion;
	if (expected !== undefined && (!Number.isSafeInteger(expected) || (expected as number) < 0)) {
		return json({ error: "expectedVersion must be a non-negative integer" }, 400);
	}
	if (record.superagent && record.status === "live" && namespaceId !== null && namespaceId !== record.namespaceId) {
		return json({ error: "running superagents cannot enter another namespace; start a fresh operator session" }, 409);
	}
	const affected = [id];
	if (record.superagent) {
		for (const worker of ctx.sessions.list()) {
			if (worker.controllerId === record.id) affected.push(worker.id);
		}
	}
	return ctx.fleet.moveSessions(affected, () => {
		if (ctx.sessions.get(id) !== record) return json({ error: "session not found" }, 404);
		const previousNamespaceId = record.namespaceId;
		const previousControllerId = record.controllerId;
		const next = ctx.fleet.assign(id, namespaceId, expected as number | undefined);
		if (!next) return json({ error: "membership version changed" }, 409);
		ctx.sessions.applyMembership(id, next);
		if (record.superagent) {
			for (const worker of ctx.sessions.list()) {
				if (worker.controllerId === record.id) ctx.sessions.applyMembership(worker.id, ctx.fleet.membership(worker.id));
			}
		}
		if (namespaceId !== previousNamespaceId) {
			if (previousControllerId) {
				const event = { id: randomId("e_"), sessionId: id, kind: "namespace_revoked", createdAt: Date.now() };
				notifyOrEscalate(previousControllerId, event, ctx);
			}
			if (namespaceId !== null) announceAttachedWorker(record, ctx);
		}
		return json({ session: record });
	});
}

async function createSession(req: Request, ctx: ApiContext, fleetOwner?: SessionRecord): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	if (fleetOwner && Object.keys(body).some(key => !["machineId", "cwd", "name", "prompt", "profile", "forkFrom"].includes(key))) {
		return json({ error: "fleet start accepts machineId, cwd, name, prompt, profile and forkFrom only" }, 400);
	}
	const forkFrom = body.forkFrom;
	if (fleetOwner && forkFrom !== undefined && (typeof forkFrom !== "string" || !/^s_[A-Za-z0-9_-]+$/.test(forkFrom))) {
		return json({ error: "forkFrom must be a session id" }, 400);
	}
	if (!fleetOwner && forkFrom !== undefined) return json({ error: "forkFrom is a fleet-only field" }, 400);
	// JSON parsing awaits I/O; an admin could revoke the operator during that
	// await. Bind the start to the operator's current membership, not a stale
	// authorization decision made before parsing its request.
	if (fleetOwner) {
		const scope = ctx.fleet.membership(fleetOwner.id);
		if (!scope.namespaceId || scope.namespaceId !== fleetOwner.namespaceId ||
			fleetOwner.status !== "live" || !ctx.agents.isOnline(fleetOwner.machineId)) {
			return json({ error: "fleet operator unavailable" }, 403);
		}
	}

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
	const namespaceId = fleetOwner
		? fleetOwner.namespaceId
		: body.namespaceId === undefined ? null : body.namespaceId;
	if (namespaceId !== null && typeof namespaceId !== "string") return json({ error: "invalid namespaceId" }, 400);
	const namespace = namespaceId === null ? undefined : ctx.fleet.getNamespace(namespaceId);
	if (namespaceId !== null && !namespace) return json({ error: "namespace not found" }, 404);
	if (namespace?.machineIds !== null && namespace?.machineIds !== undefined && !namespace.machineIds.includes(machineId)) {
		return json({ error: "machine is not allowed in this namespace" }, 403);
	}
	const source = typeof forkFrom === "string" ? ctx.sessions.get(forkFrom) : undefined;
	if (forkFrom !== undefined && (!source || ctx.fleet.membership(source.id).namespaceId !== namespaceId)) {
		return json({ error: "session not found" }, 404);
	}
	if (source) {
		if (source.superagent || ctx.fleet.membership(source.id).controllerId !== fleetOwner?.id) {
			return json({ error: "claim this session before forking it" }, 403);
		}
		if (source.status !== "live" || !ctx.agents.isOnline(source.machineId)) {
			return json({ error: "fork source is not live" }, 409);
		}
		if (!source.sessionFile) return json({ error: "source session is not persisted" }, 409);
		if (source.machineId !== machineId || source.cwd !== cwd || (body.profile !== undefined && profile !== source.profile)) {
			return json({ error: "fork must use the source machine, cwd and profile" }, 400);
		}
		profile = source.profile;
	}

	// Optional resume target: present-but-empty is a caller bug, not "start
	// fresh" — silently degrading a resume click into a blank session would
	// look like lost history.
	const rawSessionFile = body.sessionFile;
	if (rawSessionFile !== undefined && (typeof rawSessionFile !== "string" || rawSessionFile.trim() === "")) {
		return json({ error: "sessionFile must be a non-empty string" }, 400);
	}
	const sessionFile = typeof rawSessionFile === "string" ? rawSessionFile.trim() : undefined;

	// Fleet-operator opt-in must be exactly the boolean `true`; anything else is
	// a caller bug worth surfacing, not a falsy default.
	const superagent = body["superagent"];
	if (superagent !== undefined && typeof superagent !== "boolean") {
		return json({ error: "superagent must be a boolean" }, 400);
	}
	const requestedMode = body.searchMode;
	if (requestedMode !== undefined && requestedMode !== "fleet" && requestedMode !== "sql") {
		return json({ error: "searchMode must be fleet or sql" }, 400);
	}
	if (requestedMode !== undefined && superagent !== true) {
		return json({ error: "searchMode requires superagent" }, 400);
	}
	const searchMode = superagent === true ? requestedMode ?? "fleet" : undefined;
	if (superagent === true) {
		if (namespaceId === null) return json({ error: "superagent requires namespaceId" }, 400);
		if (!supportsFleetNamespace(ctx.agents.agentVersion(machineId))) {
			return json({ error: "machine daemon must be upgraded for namespace-scoped superagents" }, 409);
		}
	}
	if (searchMode === "sql" && !supportsFleetSqlQuery(ctx.agents.agentVersion(machineId))) {
		return json({ error: "machine daemon must be upgraded for SQL transcript search" }, 409);
	}

	// Tool whitelist (protocol §2 `start.tools`): a non-empty array of non-empty
	// strings. Trimmed + deduped (first-seen order) so the record and the start
	// frame carry one canonical form.
	const rawTools = body["tools"];
	if (rawTools !== undefined) {
		const malformed =
			!Array.isArray(rawTools) ||
			rawTools.length === 0 ||
			rawTools.some(name => typeof name !== "string" || name.trim() === "");
		if (malformed) return json({ error: "tools must be a non-empty array of non-empty strings" }, 400);
	}
	const tools = Array.isArray(rawTools)
		? [...new Set(rawTools.map(name => (name as string).trim()))]
		: undefined;
	if (superagent === true && tools !== undefined) return json({ error: "superagent tools are managed by the fleet" }, 400);
	// Startup hand-offs (0.9.0+): `true` = SDK default target, a string = explicit
	// model/role pattern; anything else is a caller bug (protocol §2 start.prewalk).
	const handoff = (key: string): boolean | string | undefined | Response => {
		const raw = body[key];
		if (raw === undefined) return undefined;
		if (typeof raw === "boolean") return raw;
		if (typeof raw === "string" && raw.trim() !== "") return raw;
		return json({ error: `${key} must be a boolean or a non-empty string` }, 400);
	};
	const prewalk = handoff("prewalk");
	if (prewalk instanceof Response) return prewalk;
	const planYolo = handoff("planYolo");
	if (planYolo instanceof Response) return planYolo;

	const start = (file: string | undefined): Response => {
		const record = ctx.sessions.create({
			machineId,
			machineName: machine.name,
			cwd,
			name: field(body, "name"),
			profile,
			...(superagent === true ? { superagent: true as const } : {}),
			...(searchMode === undefined ? {} : { searchMode }),
			...(tools === undefined ? {} : { tools }),
			namespaceId,
		});
		try {
			if (namespaceId !== null) ctx.sessions.applyMembership(record.id, ctx.fleet.assign(record.id, namespaceId)!);
			if (fleetOwner) {
				const claim = ctx.fleet.claim(record.id, fleetOwner.id);
				if (!claim) throw new Error("fleet worker could not be claimed");
				ctx.sessions.applyMembership(record.id, claim);
				ctx.fleet.watch(fleetOwner.id, record.id);
			}
		} catch (err) {
			ctx.sessions.delete(record.id);
			try {
				ctx.fleet.removeSession(record.id);
			} catch (cleanupErr) {
				log.warn(`fleet rollback for ${record.id} failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
			}
			return fleetStateFailure(err);
		}
		const prompt = field(body, "prompt");
		const base = derivePublicBase(req, ctx.cfg);
		const dispatched = ctx.agents.send(machineId, {
			t: "start",
			id: record.id,
			cwd: record.cwd,
			name: record.name,
			...(prompt === undefined ? {} : { prompt }),
			...(profile === undefined ? {} : { profile }),
			...(file === undefined ? {} : { sessionFile: file }),
			...(superagent === true ? { superagent: true } : {}),
			...(searchMode === undefined ? {} : { searchMode }),
			...(tools === undefined ? {} : { tools }),
			...(prewalk === undefined ? {} : { prewalk }),
			...(planYolo === undefined ? {} : { planYolo }),
			relayUrl: base.wsBase,
			webUrl: base.httpBase,
		});
		if (!dispatched) {
			ctx.fleet.removeSession(record.id);
			ctx.sessions.delete(record.id);
			return json({ error: "machine write failed" }, 502);
		}
		if (!fleetOwner && namespaceId !== null) announceAttachedWorker(record, ctx);
		return json({ session: record }, 202);
	};
	if (!source) return start(sessionFile);
	return ctx.fleet.mutateWorker(source.id, async () => {
		const membership = ctx.fleet.membership(source.id);
		if (!fleetOwner || source.status !== "live" || membership.namespaceId !== namespaceId ||
			membership.controllerId !== fleetOwner.id || fleetOwner.status !== "live" ||
			ctx.fleet.membership(fleetOwner.id).namespaceId !== namespaceId) {
			return json({ error: "fork source membership changed" }, 409);
		}
		const result = await dispatchCmd(source.id, "fleet-fork-session", {}, ctx);
		if (!result.ok) return result.response;
		if (source.status !== "live" || membership.membershipVersion !== ctx.fleet.membership(source.id).membershipVersion ||
			fleetOwner.status !== "live" || ctx.fleet.membership(fleetOwner.id).namespaceId !== namespaceId) {
			return json({ error: "fork source membership changed" }, 409);
		}
		const file = pick(result.data, "sessionFile");
		if (typeof file !== "string" || file === "") return json({ error: "malformed fork result" }, 502);
		return start(file);
	});
}

function stopSession(id: string, ctx: ApiContext): Response {
	const record = ctx.sessions.get(id);
	if (!record) return json({ error: "session not found" }, 404);
	if (record.status === "exited" || record.status === "failed") {
		return json({ error: "session already finished" }, 409);
	}
	if (!ctx.agents.isOnline(record.machineId)) return json({ error: "agent offline" }, 502);
	// The record flips only after the owning daemon reports session-exit.
	if (!ctx.agents.send(record.machineId, { t: "stop", id: record.id, reason: "user stop" })) {
		return json({ error: "agent offline" }, 502);
	}
	return json({ ok: true });
}

/**
 * Restart a terminal session under its old id (protocol §3): re-sends the
 * stored start parameters — resuming the session's transcript when
 * `session-ready` minted a `sessionFile`, a fresh start in the same
 * cwd/profile otherwise. The frame goes out before the record flips, so a
 * failed dispatch leaves the terminal record untouched. No new agent frame:
 * this is the plain `start` the daemon-restart resume already speaks.
 */
function restartSession(id: string, req: Request, ctx: ApiContext): Response {
	const record = ctx.sessions.get(id);
	if (!record) return json({ error: "session not found" }, 404);
	if (!isTerminalStatus(record.status)) return json({ error: "session is not finished" }, 409);
	const machine = ctx.agents.getMachine(record.machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!machine.connected) return json({ error: "machine offline" }, 404);
	if (record.superagent) {
		if (!record.namespaceId) return json({ error: "superagent requires namespaceId" }, 409);
		if (!supportsFleetNamespace(ctx.agents.agentVersion(record.machineId))) {
			return json({ error: "machine daemon must be upgraded for namespace-scoped superagents" }, 409);
		}
		if (record.searchMode === "sql" && !supportsFleetSqlQuery(ctx.agents.agentVersion(record.machineId))) {
			return json({ error: "machine daemon must be upgraded for SQL transcript search" }, 409);
		}
	}
	const base = derivePublicBase(req, ctx.cfg);
	const dispatched = ctx.agents.send(record.machineId, {
		t: "start",
		id: record.id,
		cwd: record.cwd,
		...(record.name ? { name: record.name } : {}),
		...(record.profile ? { profile: record.profile } : {}),
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.tools ? { tools: record.tools } : {}),
		...(record.superagent ? { superagent: true } : {}),
		...(record.superagent ? { searchMode: record.searchMode ?? "fleet" } : {}),
		relayUrl: base.wsBase,
		webUrl: base.httpBase,
	});
	if (!dispatched) return json({ error: "machine write failed" }, 502);
	const resumed = ctx.sessions.reissue(id, { requireSessionFile: false });
	ctx.agents.trackReissuedSession(record.machineId, id);
	return json({ session: resumed }, 202);
}

/**
 * Delete a session from the hub registry. A live/starting session is stopped
 * first — the same fire-and-forget `stop` as POST /stop — then the record is
 * dropped immediately, so the listing forgets it without waiting for the
 * child to exit. The machine-side omp session file is untouched; `/resume`
 * can still re-attach to the conversation.
 */
function deleteSession(id: string, ctx: ApiContext): Response {
	const record = ctx.sessions.get(id);
	if (!record) return json({ error: "session not found" }, 404);
	try {
		ctx.fleet.removeSession(id);
	} catch (err) {
		return fleetStateFailure(err);
	}
	if (record.status !== "exited" && record.status !== "failed") {
		ctx.agents.send(record.machineId, { t: "stop", id: record.id, reason: "user delete" });
	}
	ctx.sessions.delete(id);
	if (record.superagent) {
		for (const worker of ctx.sessions.list()) {
			if (worker.controllerId === id) ctx.sessions.applyMembership(worker.id, ctx.fleet.membership(worker.id));
		}
	}
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
 *
 * `?profile=<name>` (0.5.0+) selects the named omp profile's dashboard: the
 * parameter is consumed here and travels on the frame, never in the forwarded
 * dashboard path. `"default"` and an empty value mean the default profile.
 */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** First release whose agent starts per-profile stats dashboards (protocol 0.5.0). */
const PROFILE_RELAY_VERSION: readonly [number, number, number] = [0, 5, 0];

function supportsProfileRelay(version: string | null): boolean {
	if (version === null) return false;
	const triple = versionTriple(version);
	if (!triple) return false;
	return triple[0] !== PROFILE_RELAY_VERSION[0]
		? triple[0] > PROFILE_RELAY_VERSION[0]
		: triple[1] !== PROFILE_RELAY_VERSION[1]
			? triple[1] > PROFILE_RELAY_VERSION[1]
			: triple[2] >= PROFILE_RELAY_VERSION[2];
}

async function usageProxy(machineId: string, rest: string, search: string, req: Request, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
		return json({ error: "method not allowed" }, 405);
	}
	if (!machine.connected || !ctx.agents.isOnline(machineId)) return json({ error: "machine offline" }, 502);

	const params = new URLSearchParams(search);
	const rawProfile = params.get("profile");
	params.delete("profile");
	const query = params.toString();
	const forwardSearch = query !== "" ? `?${query}` : "";
	let profile: string | undefined;
	if (rawProfile !== null && rawProfile !== "" && rawProfile !== "default") {
		if (!PROFILE_NAME_RE.test(rawProfile)) return json({ error: "invalid profile name" }, 400);
		const version = ctx.agents.agentVersion(machineId);
		if (!supportsProfileRelay(version)) {
			return json({ error: `agent ${version ?? "unknown"} does not support profile usage relay (needs 0.5.0+)` }, 400);
		}
		profile = rawProfile;
	}

	let bodyB64: string | undefined;
	if (req.method === "POST") {
		const body = new Uint8Array(await req.arrayBuffer());
		if (body.byteLength > MAX_USAGE_BODY_BYTES) return json({ error: "request body too large" }, 413);
		bodyB64 = body.byteLength > 0 ? Buffer.from(body).toString("base64") : undefined;
	}

	const result = await ctx.agents.sendUsageRequest(machineId, req.method, `${rest}${forwardSearch}`, bodyB64, profile);
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

/** Fetch one profile's live quota from the machine's isolated SDK worker. */
async function machineSubscriptionUsage(machineId: string, req: Request, ctx: ApiContext): Promise<Response> {
	if (!ctx.agents.getMachine(machineId)) return json({ error: "machine not found" }, 404);
	if (!ctx.agents.isOnline(machineId)) return json({ error: "agent offline" }, 502);
	const params = new URL(req.url).searchParams;
	const values = params.getAll("profile");
	if (values.length > 1) return json({ error: "invalid profile name" }, 400);
	const raw = values[0] ?? "default";
	if (raw !== "default" && (
		raw === "all" || !PROFILE_NAME_RE.test(raw) || raw.endsWith(".")
		|| /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(raw)
	)) return json({ error: "invalid profile name" }, 400);

	const result = await ctx.agents.sendCmd(machineId, {
		reqId: newCmdReqId(),
		cmd: "get-subscriptions",
		profile: raw,
	}, 95_000);
	if (!result.ok) {
		const status = result.error.startsWith("unknown machine command") ? 501 : result.error === "profile not found" ? 404
			: cmdErrorStatus(result.error);
		const error = status === 501 ? "agent does not support subscription usage" : result.error;
		return json({ error }, status);
	}
	const usage = result.data;
	if (!usage || typeof usage !== "object" || !("fetchedAt" in usage) || typeof usage.fetchedAt !== "number"
		|| !("reports" in usage) || !Array.isArray(usage.reports)
		|| !("unavailable" in usage) || !Array.isArray(usage.unavailable)) {
		return json({ error: "invalid subscription response" }, 502);
	}
	return json(usage);
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

/**
 * `POST /api/machines/:id/restart-daemon` (protocol §3): panel-triggered daemon
 * upgrade. The hub arms a same-id resume plan; the fresh daemon's first
 * heartbeat replays it (`AgentRegistry.restartDaemon`). 404 unknown machine,
 * 409 already restarting, 502 offline, 400/504 for agent-reported refusals.
 */
async function restartMachineDaemon(machineId: string, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	const result = await ctx.agents.restartDaemon(machineId);
	if (!result.ok) {
		const status = result.error === "daemon restart already in progress" ? 409 : cmdErrorStatus(result.error);
		return json({ error: result.error }, status);
	}
	return json({ ok: true, machine: ctx.agents.getMachine(machineId) });
}

/**
 * Message-text search over session files on one machine (protocol §2
 * `search-sessions`): forwards the trimmed needle and the caller's candidate
 * paths — defaulting to every registry session's `sessionFile` on that
 * machine — and relays the agent's per-file hits keyed by path. Validation
 * failures answer 400 without touching the agent; plumbing status codes mirror
 * `listMachineSessions`.
 */
async function searchMachineSessions(machineId: string, req: Request, ctx: ApiContext): Promise<Response> {
	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!ctx.agents.isOnline(machineId)) return json({ error: "agent offline" }, 502);
	const body = await jsonBody(req);
	if (!body) return json({ error: "invalid JSON body" }, 400);
	const query = body.query;
	if (typeof query !== "string" || query.trim() === "") return json({ error: "query is required" }, 400);
	if (query.trim().length > MAX_SEARCH_QUERY_CHARS) return json({ error: "query too long" }, 400);

	let paths: string[];
	if (body.paths === undefined) {
		paths = [...new Set(ctx.sessions.list().filter(record => record.machineId === machineId && record.sessionFile).map(record => record.sessionFile!))];
	} else {
		if (!Array.isArray(body.paths)) return json({ error: "invalid paths" }, 400);
		const requested: string[] = [];
		for (const entry of body.paths) {
			if (typeof entry !== "string") return json({ error: "invalid paths" }, 400);
			requested.push(entry);
		}
		paths = [...new Set(requested)];
	}
	if (paths.length > MAX_SEARCH_PATHS) return json({ error: "too many paths" }, 400);

	const result = await ctx.agents.sendCmd(machineId, {
		reqId: newCmdReqId(),
		cmd: "search-sessions",
		query: query.trim(),
		paths,
	});
	if (!result.ok) return json({ error: result.error }, cmdErrorStatus(result.error));
	const results = pick(result.data, "results");
	return json({ ok: true, matches: Array.isArray(results) ? results.filter(isSearchHit) : [] });
}

/** Narrows one relayed `search-sessions` hit; malformed entries are dropped. */
function isSearchHit(entry: unknown): entry is { path: string; count: number; snippet?: string } {
	if (typeof entry !== "object" || entry === null || !("path" in entry) || !("count" in entry)) return false;
	if (typeof entry.path !== "string" || typeof entry.count !== "number") return false;
	return !("snippet" in entry) || entry.snippet === undefined || typeof entry.snippet === "string";
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
	const role = field(body, "role");
	if (role !== undefined && (role.trim() === "" || role.length > 64)) {
		return json({ error: "invalid role" }, 400);
	}
	const persist = body["persist"];
	if (persist !== undefined && typeof persist !== "boolean") {
		return json({ error: "persist must be a boolean" }, 400);
	}
	const clearRole = body["clearRole"];
	if (clearRole !== undefined && typeof clearRole !== "boolean") {
		return json({ error: "clearRole must be a boolean" }, 400);
	}
	const level = field(body, "level");
	if (level !== undefined && level.trim() === "") {
		return json({ error: "invalid level" }, 400);
	}

	// 0.10.0 `clearRole` unassigns the role: `role` carries the target and
	// `provider`/`modelId` are meaningless on this path.
	if (clearRole === true) {
		if (role === undefined) return json({ error: "role is required with clearRole" }, 400);
		const outcome = await dispatchCmd(id, "set-model", { role, clearRole: true }, ctx);
		return outcome.ok
			? json({
					ok: true,
					switched: pick(outcome.data, "switched") ?? false,
					role: pick(outcome.data, "role") ?? role,
					thinkingLevel: pick(outcome.data, "thinkingLevel") ?? null,
				})
			: outcome.response;
	}

	const provider = field(body, "provider");
	if (!provider || provider.trim() === "") return json({ error: "provider is required" }, 400);
	const modelId = field(body, "modelId");
	if (!modelId || modelId.trim() === "") return json({ error: "modelId is required" }, 400);

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
 * `prompt {text}` (protocol §2): deliver text to a live session as a new turn or
 * queued steering. The reply only confirms the dispatch; the turn itself streams
 * through the normal session channel.
 */
async function promptSession(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const text = field(body, "text");
	if (!text || text.trim() === "") return json({ error: "text is required" }, 400);

	const outcome = await dispatchCmd(id, "prompt", { text }, ctx);
	return outcome.ok ? json({ ok: true, accepted: pick(outcome.data, "accepted") ?? true }) : outcome.response;
}

/**
 * Notices (protocol §3, 0.8.0+): agents post human-facing notifications; web
 * clients poll the listing. Validation failures are caller bugs → 400.
 */
async function createNotice(req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	try {
		const notice = ctx.notices.add({ message: body["message"], urgency: body["urgency"], sessionId: body["sessionId"] });
		return json({ ok: true, notice });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
}

/**
 * Browsable session tree for the web `/tree` picker (agent `get-tree`): the
 * host's full entry tree reduced to one-line previews, with the active leaf
 * path marked. Read-only — switching leaves goes through `navigateTree`.
 */
async function sessionTree(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "get-tree", {}, ctx);
	if (!outcome.ok) return outcome.response;
	const data = outcome.data as Record<string, unknown>;
	return json({
		ok: true,
		leafId: pick(data, "leafId") ?? null,
		truncated: pick(data, "truncated") ?? false,
		nodes: Array.isArray(data["nodes"]) ? data["nodes"] : [],
	});
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
 * Shake heavy content out of the context (TUI `/shake`): a local, model-free
 * transform, so the counts-based result settles inside the cmd budget and
 * replies verbatim — the caller owns the formatting.
 */
async function shakeSession(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const mode = body["mode"];
	if (mode !== undefined && typeof mode !== "string") return json({ error: "mode must be a string" }, 400);

	const outcome = await dispatchCmd(id, "shake", { ...(typeof mode === "string" ? { mode } : {}) }, ctx);
	if (!outcome.ok) return outcome.response;
	if (outcome.data === null || typeof outcome.data !== "object") return json({ error: "malformed shake result" }, 500);
	return json({ ok: true, result: outcome.data });
}

/**
 * Hand the session off to a handoff document and compact in place (TUI
 * `/handoff`): a model call, so this only confirms the background dispatch —
 * the document lands through the transcript (contract §1).
 */
async function handoffSession(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const instructions = body["instructions"];
	if (instructions !== undefined && typeof instructions !== "string") {
		return json({ error: "instructions must be a string" }, 400);
	}

	const outcome = await dispatchCmd(id, "handoff", {
		...(typeof instructions === "string" ? { instructions } : {}),
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

/**
 * Clear the conversation context in place (web `/clear`, TUI `/clear` parity).
 * The host refuses while a turn streams — the agent's "Wait for the current
 * response…" error maps to 409 in `cmdErrorStatus`.
 */
async function clearSessionContext(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "clear-context", {}, ctx);
	if (!outcome.ok) return outcome.response;
	return json({ ok: true, droppedCount: pick(outcome.data, "droppedCount") ?? 0 });
}

/**
 * Rename a live session (protocol §2 `rename`): the agent-side session name is
 * the source of truth — it pins against auto-titles and rides the collab
 * snapshot — and the registry label follows so `/api/sessions` reflects the
 * rename on the next poll. Only live sessions rename (dispatchCmd gates on it).
 */
async function renameSession(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const name = field(body, "name");
	if (name === undefined || name.trim() === "") return json({ error: "name is required" }, 400);
	if (name.length > 200) return json({ error: "name is too long (max 200)" }, 400);

	const outcome = await dispatchCmd(id, "rename", { name }, ctx);
	if (!outcome.ok) return outcome.response;
	const applied = pick(outcome.data, "name");
	const appliedName = typeof applied === "string" && applied.trim() !== "" ? applied : name;
	const record = ctx.sessions.rename(id, appliedName);
	return json({ ok: true, name: appliedName, session: record });
}

/**
 * Generate a session title from the conversation (protocol §2 `generate-title`):
 * the web's bare `/rename`, mirroring the TUI's bare `/rename`. The title model
 * summarizes the first user turn, the result pins as a user rename, and the
 * registry label follows like `rename` so `/api/sessions` reflects it.
 */
async function generateSessionTitle(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "generate-title", {}, ctx);
	if (!outcome.ok) return outcome.response;
	const applied = pick(outcome.data, "name");
	if (typeof applied !== "string" || applied.trim() === "") return json({ error: "agent returned no title" }, 502);
	const record = ctx.sessions.rename(id, applied);
	return json({ ok: true, name: applied, session: record });
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

const PREWALK_ACTIONS: Record<string, true> = { arm: true, restart: true, state: true };

/**
 * Arm or inspect the one-shot prewalk hand-off (protocol §2 `prewalk`, 0.9.0+):
 * `arm` resolves the target and arms, `restart` restores the pre-prewalk model
 * and re-arms, bare/`state` just reports. The armed projection echoes back.
 */
async function sessionPrewalk(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const action = field(body, "action");
	if (action !== undefined && !PREWALK_ACTIONS[action]) return json({ error: "action must be arm, restart, or state" }, 400);
	const target = field(body, "target");
	if (body["target"] !== undefined && target === undefined) return json({ error: "target must be a non-empty string" }, 400);
	const level = field(body, "level");
	if (body["level"] !== undefined && level === undefined) return json({ error: "level must be a non-empty string" }, 400);

	const outcome = await dispatchCmd(id, "prewalk", {
		...(action === undefined ? {} : { action }),
		...(target === undefined ? {} : { target }),
		...(level === undefined ? {} : { level }),
	}, ctx);
	if (!outcome.ok) return outcome.response;
	const extra = action === "arm"
		? { armed: pick(outcome.data, "armed") }
		: action === "restart"
			? { result: pick(outcome.data, "result") }
			: {};
	return json({ ok: true, prewalk: pick(outcome.data, "prewalk"), ...extra });
}

const PLAN_ACTIONS: Record<string, true> = { enable: true, disable: true, status: true };

/** Plan mode toggle/report (protocol §2 `plan`, 0.9.0+); the plan state echoes back. */
async function sessionPlan(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const action = field(body, "action");
	if (action !== undefined && !PLAN_ACTIONS[action]) return json({ error: "action must be enable, disable, or status" }, 400);
	const planFilePath = field(body, "planFilePath");
	if (body["planFilePath"] !== undefined && planFilePath === undefined) {
		return json({ error: "planFilePath must be a non-empty string" }, 400);
	}

	const outcome = await dispatchCmd(id, "plan", {
		...(action === undefined ? {} : { action }),
		...(planFilePath === undefined ? {} : { planFilePath }),
	}, ctx);
	return outcome.ok ? json({ ok: true, plan: pick(outcome.data, "plan") }) : outcome.response;
}

const ADVISOR_ACTIONS: Record<string, true> = { enable: true, disable: true, status: true };

/**
 * Second-model advisor toggle (protocol §2 `advisor`, 0.9.0+); the reply
 * carries the toggle plus the discovered advisor names. Enabling with no
 * discovered configs fails agent-side → 500 via the default mapping.
 */
async function sessionAdvisor(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const action = field(body, "action");
	if (action !== undefined && !ADVISOR_ACTIONS[action]) return json({ error: "action must be enable, disable, or status" }, 400);

	const outcome = await dispatchCmd(id, "advisor", action === undefined ? {} : { action }, ctx);
	if (!outcome.ok) return outcome.response;
	return json({
		ok: true,
		enabled: pick(outcome.data, "enabled"),
		advisors: Array.isArray(pick(outcome.data, "advisors")) ? pick(outcome.data, "advisors") : [],
	});
}

const TIER_FAMILIES: Record<string, readonly string[]> = {
	openai: ["none", "auto", "default", "flex", "scale", "priority"],
	anthropic: ["none", "priority"],
	google: ["none", "flex", "priority"],
};

const TIER_ACTIONS: Record<string, true> = { set: true, status: true };

/**
 * Service tiers per provider family (protocol §2 `tier`, 0.9.0+). The family
 * table is frozen wire knowledge, so the hub rejects unknown families and
 * off-table tiers before the round trip; "family omitted with no current
 * model" is agent knowledge and maps to 400 via `reject400`.
 */
async function sessionTier(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const action = field(body, "action");
	if (action !== undefined && !TIER_ACTIONS[action]) return json({ error: "action must be set or status" }, 400);
	const family = field(body, "family");
	if (body["family"] !== undefined && (family === undefined || !TIER_FAMILIES[family])) {
		return json({ error: "family must be openai, anthropic, or google" }, 400);
	}
	const tier = field(body, "tier");
	if (body["tier"] !== undefined && (tier === undefined || (family !== undefined && !TIER_FAMILIES[family]!.includes(tier)))) {
		return json({ error: "tier is not valid for the family" }, 400);
	}

	const outcome = await dispatchCmd(id, "tier", {
		...(action === undefined ? {} : { action }),
		...(family === undefined ? {} : { family }),
		...(tier === undefined ? {} : { tier }),
	}, ctx, true);
	return outcome.ok ? json({ ok: true, tiers: pick(outcome.data, "tiers") ?? {} }) : outcome.response;
}

/**
 * Freeze/resume the session's agent loop through the SDK pause gate (protocol
 * §2 `pause`, 0.9.0+); omitted `enabled` toggles on the agent.
 */
async function sessionPause(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const enabled = body["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return json({ error: "enabled must be a boolean" }, 400);
	}

	const outcome = await dispatchCmd(id, "pause", typeof enabled === "boolean" ? { enabled } : {}, ctx);
	return outcome.ok ? json({ ok: true, paused: pick(outcome.data, "paused") ?? false }) : outcome.response;
}

const CYCLE_DIRECTIONS: Record<string, true> = { forward: true, backward: true };

/** Cycle the session's model list or configured role models (protocol §2 `cycle-model`, 0.9.0+; `roleCycle` 0.10.0+). */
async function sessionCycle(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const direction = field(body, "direction");
	if (direction !== undefined && !CYCLE_DIRECTIONS[direction]) {
		return json({ error: "direction must be forward or backward" }, 400);
	}
	const roleCycle = body["roleCycle"];
	if (roleCycle !== undefined && typeof roleCycle !== "boolean") {
		return json({ error: "roleCycle must be a boolean" }, 400);
	}

	const outcome = await dispatchCmd(id, "cycle-model", {
		...(direction === undefined ? {} : { direction }),
		...(roleCycle === true ? { roleCycle: true } : {}),
	}, ctx);
	return outcome.ok
		? json({ ok: true, ...pickRecord(outcome.data, ["switched", "model", "thinkingLevel"]) })
		: outcome.response;
}

/** Hub-curated settings allowlist with current values (protocol §2 `get-settings`, 0.9.0+). */
async function sessionSettings(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "get-settings", {}, ctx);
	if (!outcome.ok) return outcome.response;
	const data = outcome.data as Record<string, unknown>;
	return json({ ok: true, settings: Array.isArray(data["settings"]) ? data["settings"] : [] });
}

/**
 * Session-scoped runtime setting override (protocol §2 `set-setting`, 0.9.0+):
 * `value` must be present as a key (`null` clears); unknown/disallowed ids and
 * type-invalid values are agent-reported → 400 via `reject400`.
 */
async function setSessionSetting(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const settingId = field(body, "settingId");
	if (!settingId) return json({ error: "settingId is required" }, 400);
	if (!("value" in body)) return json({ error: "value is required" }, 400);

	const outcome = await dispatchCmd(id, "set-setting", { settingId, value: body["value"] }, ctx, true);
	return outcome.ok ? json({ ok: true, setting: pick(outcome.data, "setting") }) : outcome.response;
}

/**
 * Streams one `cmd` to the owning agent: 404 unknown session, 409 unless `live`,
 * 502 agent offline, 504 agent silent past `cmdTimeoutMs`, 500 anything else.
 * `reject400` remaps agent-reported failures that default to 500 (caller-input
 * rejections the protocol pins to 400, e.g. an unknown setting id) to 400.
 */
async function dispatchCmd(id: string, cmd: CmdName, params: CmdParams, ctx: ApiContext, reject400 = false): Promise<CmdOutcome> {
	const record = ctx.sessions.get(id);
	if (!record) return { ok: false, response: json({ error: "session not found" }, 404) };
	if (record.status !== "live") return { ok: false, response: json({ error: `session is ${record.status}` }, 409) };
	if (!ctx.agents.isOnline(record.machineId)) return { ok: false, response: json({ error: "agent offline" }, 502) };

	const result = await ctx.agents.sendCmd(record.machineId, { id: record.id, reqId: newCmdReqId(), cmd, ...params });
	if (!result.ok) return { ok: false, response: json({ error: result.error }, reject400 && cmdErrorStatus(result.error) === 500 ? 400 : cmdErrorStatus(result.error)) };
	return { ok: true, data: result.data };
}

/**
 * `upload-file` (protocol §2): stream the raw request body to the owning session's machine
 * and answer with the written file's absolute path for `@` references in prompts.
 * 400 missing/oversized `X-Filename`, 413 body over the cap, 404/409/502/504 via {@link dispatchCmd}.
 */
async function uploadSessionFile(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const encodedName = req.headers.get("x-filename");
	if (!encodedName) return json({ error: "x-filename header is required" }, 400);
	const name = decodeURIComponent(encodedName).trim();
	if (name === "" || name.length > MAX_FILENAME_CHARS) return json({ error: "invalid x-filename" }, 400);

	const declared = Number(req.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_UPLOAD_BODY_BYTES) return json({ error: "file too large" }, 413);
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > MAX_UPLOAD_BODY_BYTES) return json({ error: "file too large" }, 413);
	if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);

	const outcome = await dispatchCmd(id, "upload-file", { name, dataB64: Buffer.from(bytes).toString("base64") }, ctx);
	if (!outcome.ok) return outcome.response;
	const path = pick(outcome.data, "path");
	if (typeof path !== "string" || path === "") return json({ error: "malformed upload-file result" }, 500);
	const written = pick(outcome.data, "bytes");
	return json({ ok: true, path, bytes: typeof written === "number" ? written : bytes.byteLength });
}

/**
 * MCP server listing for the web `/mcp` modal (agent `mcp-list`, protocol §2):
 * config rows for the user and project `mcp.json` files, redacted (URL query
 * and userinfo stripped, env values as `envCount` only), joined with the
 * session's live manager view (health, catalogs) where it has the server.
 * Config edits apply to new sessions; `health` shows what the live session
 * actually loaded.
 */
async function listMcpServers(id: string, ctx: ApiContext): Promise<Response> {
	const outcome = await dispatchCmd(id, "mcp-list", {}, ctx);
	if (!outcome.ok) return outcome.response;
	const data = outcome.data as Record<string, unknown>;
	return json({ ok: true, servers: Array.isArray(data["servers"]) ? data["servers"] : [] });
}

/** Validated `mcp-add` frame: stdio (`command`+`args`) or remote (`url`+`transport`, `token`), project default. */
async function addMcpServer(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const name = field(body, "name");
	if (!name || name.trim() === "") return json({ error: "name is required" }, 400);
	if (name.length > 100) return json({ error: "name is too long (max 100 characters)" }, 400);
	const scope = field(body, "scope");
	if (scope !== undefined && scope !== "project" && scope !== "user") {
		return json({ error: "scope must be project or user" }, 400);
	}
	const url = field(body, "url");
	const command = field(body, "command");
	if ((url === undefined) === (command === undefined)) {
		return json({ error: "exactly one of url or command is required" }, 400);
	}
	const transport = field(body, "transport");
	if (transport !== undefined && transport !== "http" && transport !== "sse") {
		return json({ error: "transport must be http or sse" }, 400);
	}
	const token = field(body, "token");
	if (token !== undefined && token.trim() === "") return json({ error: "token must be a non-empty string" }, 400);
	if (token !== undefined && url === undefined) return json({ error: "token requires url" }, 400);
	const args = body["args"];
	if (args !== undefined && (!Array.isArray(args) || args.some(entry => typeof entry !== "string"))) {
		return json({ error: "args must be an array of strings" }, 400);
	}

	const outcome = await dispatchCmd(id, "mcp-add", {
		name: name.trim(),
		...(scope === undefined ? {} : { scope }),
		...(url === undefined ? {} : { url: url.trim() }),
		...(command === undefined ? {} : { command: command.trim() }),
		...(transport === undefined ? {} : { transport }),
		...(token === undefined ? {} : { token }),
		...(Array.isArray(args) && args.length > 0 ? { args } : {}),
	}, ctx);
	return outcome.ok ? json({ ok: true, ...pickRecord(outcome.data, ["name", "scope"]) }) : outcome.response;
}

/** Remove one configured server (agent `mcp-remove`); the agent errors when absent. */
async function removeMcpServer(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const name = field(body, "name");
	if (!name || name.trim() === "") return json({ error: "name is required" }, 400);
	const scope = field(body, "scope");
	if (scope !== undefined && scope !== "project" && scope !== "user") {
		return json({ error: "scope must be project or user" }, 400);
	}

	const outcome = await dispatchCmd(id, "mcp-remove", {
		name: name.trim(),
		...(scope === undefined ? {} : { scope }),
	}, ctx);
	return outcome.ok ? json({ ok: true, ...pickRecord(outcome.data, ["name", "scope"]) }) : outcome.response;
}

/**
 * Enable or disable a configured server (agent `mcp-set-enabled`, TUI
 * `/mcp enable|disable` semantics): the project entry wins, else the user
 * entry, else the user-level disabled-servers list. `where` in the reply
 * names the file that changed.
 */
async function setMcpServerEnabled(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const name = field(body, "name");
	if (!name || name.trim() === "") return json({ error: "name is required" }, 400);
	const enabled = body["enabled"];
	if (typeof enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);

	const outcome = await dispatchCmd(id, "mcp-set-enabled", { name: name.trim(), enabled }, ctx);
	return outcome.ok ? json({ ok: true, ...pickRecord(outcome.data, ["name", "enabled", "where"]) }) : outcome.response;
}

/**
 * One temporary connection to a configured, enabled server (agent `mcp-test`):
 * the reply carries the tool catalog, bounded by the agent. Connect failures
 * surface as `cmd-result` errors; the live session is untouched.
 */
async function testMcpServer(id: string, req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);
	const name = field(body, "name");
	if (!name || name.trim() === "") return json({ error: "name is required" }, 400);

	const outcome = await dispatchCmd(id, "mcp-test", { name: name.trim() }, ctx);
	if (!outcome.ok) return outcome.response;
	const data = outcome.data as Record<string, unknown>;
	return json({
		ok: true,
		name: pick(data, "name") ?? name.trim(),
		count: typeof pick(data, "count") === "number" ? pick(data, "count") : 0,
		tools: Array.isArray(data["tools"]) ? data["tools"] : [],
	});
}

/** Named fields of the agent's `data` payload; malformed payloads degrade to undefined fields. */
function pickRecord(data: unknown, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (data === null || typeof data !== "object") return out;
	for (const key of keys) out[key] = (data as Record<string, unknown>)[key];
	return out;
}

/** HTTP status for an agent-reported failure (protocol §3 session-command rows). */
function cmdErrorStatus(error: string): number {
	// `retry` state conflicts (contract §1): nothing left to replay, or a turn
	// still streaming — the agent's own message tells the caller which.
	// `handoff` shares the streaming refusal and adds its own in-progress guard.
	if (error === "Nothing to retry." || error.startsWith("Wait for the current response") || error === "Handoff generation is already in progress." ||
		error === "input request is no longer pending" || error === "cursor is not on the active branch" ||
		error.startsWith("replacement has queued work") || error.startsWith("session is busy;")) {
		return 409;
	}
	switch (error) {
		case "unknown session":
			return 409;
		case "session history unavailable":
			return 409;
		case "source session is not persisted":
			return 409;
		case "no such directory":
		case "not a directory":
		case "permission denied": // list-dir caller-input failures (protocol §2 "Machine commands")
		case "invalid upload encoding": // upload-file caller-input failures (protocol §2)
		case "empty query":
		case "query too long":
		case "invalid paths":
		case "too many paths": // search-sessions caller-input failures (protocol §2 "Machine commands")
		case "invalid input answer":
		case "requestId and answer required":
		case "limit must be between 1 and 100":
		case "invalid message mode":
		case "message requires non-blank text":
		case "replacement text must be non-blank":
		case "clearQueue must be boolean":
		case "invalid session file":
		case "session file is outside managed omp session stores":
			return 400;
		case "file too large":
			return 413;
		case "agent offline":
		case "agent disconnected": // the socket died mid-command: just as offline to the caller
			return 502;
		case "cmd timeout":
			return 504;
		default:
			// A machine command an older daemon does not know (protocol §2: unknown
			// cmds answer `ok:false` with this exact prefix) — caller asked for a
			// capability the agent lacks, not a hub fault.
			if (error.startsWith("unknown machine command")) return 400;
			// `mcp-*` writer/test failures (protocol §2): the config writer's own
			// message tells the caller which — duplicate add, missing remove,
			// name/config validation, and the enable/disable not-found guard.
			if (error.includes("already exists")) return 409;
			if (error.includes("not found in") || error.includes("not found or disabled")) return 404;
			if (error.startsWith("Server name") || error.startsWith("Invalid server config")) return 400;
			return 500;
	}
}

/** Nested field of the agent's `data` payload; undefined when the payload is malformed. */
function pick(data: unknown, key: string): unknown {
	if (data === null || typeof data !== "object") return undefined;
	return (data as Record<string, unknown>)[key];
}

/** Fleet responses are projections: the registry's full collab links are capabilities, not model data. */
function fleetSession(record: SessionRecord): Omit<SessionRecord, "links" | "sessionFile" | "pid"> {
	const { links: _links, sessionFile: _file, pid: _pid, ...safe } = record;
	return safe;
}

/**
 * Every fleet route goes through the daemon-injected owner identity and a live
 * namespace lookup. The daemon's proxy must never forward ordinary admin routes.
 */
async function handleFleetApi(route: string, req: Request, ctx: ApiContext): Promise<Response> {
	const ownerId = req.headers.get("x-fleet-owner");
	const owner = ownerId ? ctx.sessions.get(ownerId) : undefined;
	const ownerScope = owner ? ctx.fleet.membership(owner.id) : undefined;
	if (!owner || owner.superagent !== true || owner.status !== "live" || !ownerScope?.namespaceId ||
		!ctx.agents.isOnline(owner.machineId)) return json({ error: "fleet operator unavailable" }, 403);
	const namespaceId = ownerScope.namespaceId;
	const ownerVersion = ownerScope.membershipVersion;
	const ownerStillInScope = (): boolean =>
		ctx.sessions.get(owner.id) === owner && owner.superagent === true &&
		owner.status === "live" && ctx.agents.isOnline(owner.machineId) &&
		ctx.fleet.membership(owner.id).namespaceId === namespaceId &&
		ctx.fleet.membership(owner.id).membershipVersion === ownerVersion;
	const inScope = (record: SessionRecord): boolean => ctx.fleet.membership(record.id).namespaceId === namespaceId;
	const target = (id: string): SessionRecord | undefined => {
		const record = ctx.sessions.get(id);
		return record && inScope(record) ? record : undefined;
	};
	const controlled = (record: SessionRecord): boolean =>
		record.superagent !== true && ctx.fleet.membership(record.id).controllerId === owner.id;
	const routeParts = route.slice("/api/fleet/".length).split("/");
	if (route === "/api/fleet/search" && req.method === "POST") {
		if (owner.searchMode === "sql") return json({ error: "fleet transcript search is unavailable in SQL mode" }, 403);
		return searchFleetNamespace(req, ctx, owner, namespaceId, ownerVersion);
	}

	if (route === "/api/fleet/machines" && req.method === "GET") {
		const allowed = ctx.fleet.getNamespace(namespaceId)?.machineIds;
		const counts = new Map<string, number>();
		for (const record of ctx.sessions.list()) {
			if (!inScope(record) || record.status === "exited" || record.status === "failed") continue;
			counts.set(record.machineId, (counts.get(record.machineId) ?? 0) + 1);
		}
		return json({ machines: ctx.agents.listMachines()
			.filter(machine => allowed === null || allowed?.includes(machine.machineId))
			.map(({ machineId, name, connected }) =>
				({ machineId, name, connected, sessionCount: counts.get(machineId) ?? 0 })) });
	}
	if (route === "/api/fleet/sessions") {
		if (req.method === "GET") return json({ sessions: ctx.sessions.list().filter(inScope).map(fleetSession) });
		if (req.method === "POST") {
			const response = await createSession(req, ctx, owner);
			if (response.status >= 400) return response;
			const payload = await response.json() as { session: SessionRecord };
			if (!ownerStillInScope() || ctx.fleet.membership(payload.session.id).namespaceId !== namespaceId) {
				return json({ error: "fleet operator membership changed" }, 409);
			}
			return json({ session: fleetSession(payload.session) }, response.status);
		}
	}
	if (route === "/api/fleet/events" && req.method === "GET") {
		const events = ctx.fleet.events(owner.id).filter(event => {
			if (event.kind === "namespace_revoked") return true;
			const worker = target(event.sessionId);
			return worker !== undefined;
		});
		return json({ events });
	}
	if (routeParts[0] === "events" && routeParts.length === 3 && routeParts[2] === "ack" && req.method === "POST") {
		const eventId = decodeURIComponent(routeParts[1]!);
		ctx.fleet.ack(owner.id, eventId);
		ctx.agents.forgetFleetDelivery(owner.id, eventId);
		return json({ ok: true });
	}
	if (route === "/api/fleet/notices" && req.method === "POST") {
		const body = await jsonBody(req);
		if (!body) return json({ error: "invalid json body" }, 400);
		if (!ownerStillInScope()) return json({ error: "fleet operator membership changed" }, 409);
		const sessionId = body.sessionId;
		if (sessionId !== undefined && (typeof sessionId !== "string" || !target(sessionId))) {
			return json({ error: "session not found" }, 404);
		}
		try {
			return json({ ok: true, notice: ctx.notices.add({ message: body.message, urgency: body.urgency, sessionId }) });
		} catch (err) {
			return json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	}
	if (routeParts[0] !== "sessions" || routeParts.length < 2 || routeParts.length > 3) {
		return json({ error: "not found" }, 404);
	}
	const id = decodeURIComponent(routeParts[1]!);
	const worker = target(id);
	if (!worker) return json({ error: "session not found" }, 404);
	const action = routeParts[2];
	// Transcript modes are mutually exclusive; all other orchestration routes
	// remain available to operators in either mode.
	if ((action === "messages" || action === "search" || action === "message-context") &&
		owner.searchMode === "sql") return json({ error: "fleet transcript search is unavailable in SQL mode" }, 403);
	if (action === "query" && req.method === "POST" && owner.searchMode !== "sql") {
		return json({ error: "SQL transcript query requires SQL mode" }, 403);
	}
	if (action === undefined && req.method === "GET") return json({ session: fleetSession(worker) });
	if (action === "claim" && req.method === "POST") {
		if (worker.superagent) return json({ error: "another operator cannot be controlled" }, 403);
		const membership = ctx.fleet.claim(worker.id, owner.id);
		if (!membership) return json({ error: "session is controlled by another operator" }, 409);
		ctx.sessions.applyMembership(worker.id, membership);
		return json({ ok: true, controllerId: owner.id });
	}
	const reading = (req.method === "GET" && (action === "messages" || action === "search" || action === "input")) ||
		(req.method === "POST" && (action === "watch" || action === "message-context" || action === "query"));
	if (!reading && !controlled(worker)) return json({ error: "claim this session before managing it" }, 403);
	const version = ctx.fleet.membership(worker.id).membershipVersion;
	const stillAllowed = (): boolean => {
		const scope = ctx.fleet.membership(worker.id);
		return ownerStillInScope() && scope.namespaceId === namespaceId && scope.membershipVersion === version &&
			(reading || scope.controllerId === owner.id);
	};
	if (action === "query" && req.method === "POST") {
		if (worker.superagent) return json({ error: "operator sessions cannot be queried" }, 403);
		const body = await jsonBody(req);
		if (!body || Object.keys(body).length !== 1 || typeof body.sql !== "string" ||
			body.sql.trim() === "" || Buffer.byteLength(body.sql, "utf8") > 4096) {
			return json({ error: "sql must be 1–4096 UTF-8 bytes" }, 400);
		}
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		if (!ctx.agents.isOnline(worker.machineId)) return json({ error: "agent offline" }, 502);
		if (!supportsFleetSqlQuery(ctx.agents.agentVersion(owner.machineId)) ||
			!supportsFleetSqlQuery(ctx.agents.agentVersion(worker.machineId))) {
			return json({ error: "SQL transcript queries require agent 0.15.0+ on operator and worker machines" }, 409);
		}
		const liveWorker = worker.status === "live";
		if (!liveWorker && (!isTerminalStatus(worker.status) || !worker.sessionFile)) {
			return json({ error: "session history unavailable" }, 409);
		}
		const workerStatus = worker.status;
		const workerFile = worker.sessionFile;
		const workerMachine = worker.machineId;
		const result = await ctx.agents.sendCmd(workerMachine, {
			reqId: newCmdReqId(), cmd: liveWorker ? "fleet-query-messages" : "query-session-messages",
			...(liveWorker ? { id } : { path: workerFile }), sql: body.sql,
		});
		if (!stillAllowed() || ctx.sessions.get(id) !== worker || worker.status !== workerStatus ||
			worker.machineId !== workerMachine || worker.sessionFile !== workerFile) {
			return json({ error: "session membership changed" }, 409);
		}
		if (!result.ok) {
			const status = result.error.startsWith("invalid SQL:") ? 400 :
				result.error === "query timeout" || result.error === "cmd timeout" ? 504 :
				result.error.startsWith("session history unavailable") || result.error === "unknown session" ? 409 : 502;
			return json({ error: status === 502 ? "query failed" : status === 400 ? "invalid SQL" :
				status === 409 ? "session history unavailable" : result.error }, status);
		}
		return json(result.data);
	}
	if (action === "stop" && req.method === "POST") {
		return ctx.fleet.mutateWorker(id, async () => stillAllowed()
			? stopSession(id, ctx)
			: json({ error: "session membership changed" }, 409));
	}
	if (action === "watch" && req.method === "POST") {
		if (worker.superagent) return json({ error: "operator sessions cannot be watched" }, 403);
		const subscribed = ctx.fleet.watch(owner.id, id);
		if (subscribed && worker.status === "live" && ctx.agents.isOnline(worker.machineId)) {
			const pending = await dispatchCmd(id, "fleet-get-input", {}, ctx);
			if (pending.ok && stillAllowed() && Array.isArray(pick(pending.data, "pending"))) {
				for (const input of pick(pending.data, "pending") as Array<{ requestId?: unknown }>) {
					if (typeof input?.requestId !== "string") continue;
					const event = { id: randomId("e_"), sessionId: id, kind: "input_required",
						requestId: input.requestId, createdAt: Date.now() };
					for (const recipient of ctx.fleet.enqueue(event, candidate => candidate === owner.id)) {
						ctx.agents.notifyFleet(recipient, event);
					}
				}
			}
		}
		return stillAllowed() ? json({ ok: true }) : json({ error: "session membership changed" }, 409);
	}
	if (action === "messages" && req.method === "GET") {
		const query = new URL(req.url).searchParams;
		const cursor = query.get("cursor") ?? undefined;
		const rawLimit = query.get("limit");
		const pageLimit = rawLimit === null ? 20 : Number(rawLimit);
		if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100 || (cursor !== undefined && cursor.length > 128)) {
			return json({ error: "invalid cursor or limit" }, 400);
		}
		// A 0.12 operator describes forward cursors, while a 0.12 worker serves
		// the oldest page. Never combine either side with the backward contract.
		if (ctx.agents.isOnline(worker.machineId)) {
			const ownerVersion = ctx.agents.agentVersion(owner.machineId);
			if (!supportsRecentFleetMessages(ownerVersion) ||
				(worker.machineId !== owner.machineId && !supportsRecentFleetMessages(ctx.agents.agentVersion(worker.machineId)))) {
				return json({ error: "fleet message paging requires agent 0.13.0+ on operator and worker machines" }, 409);
			}
		}
		const result = worker.status === "live"
			? await dispatchCmd(id, "fleet-get-messages", { cursor, pageLimit }, ctx)
			: worker.sessionFile && ctx.agents.isOnline(worker.machineId)
				? await ctx.agents.sendCmd(worker.machineId, { reqId: newCmdReqId(), cmd: "read-session-messages",
					path: worker.sessionFile, cursor, pageLimit })
				: { ok: false as const, error: "session history unavailable" };
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		if (!result.ok) return "response" in result ? result.response : json({ error: result.error }, cmdErrorStatus(result.error));
		return json(result.data);
	}
	if (action === "search" && req.method === "GET") {
		return searchFleetSession(req, ctx, owner, worker, namespaceId, ownerVersion, version);
	}
	if (action === "message-context" && req.method === "POST") {
		return getFleetMessageContext(req, ctx, owner, worker, namespaceId, ownerVersion, version);
	}
	if (action === "input" && req.method === "GET") {
		const result = await dispatchCmd(id, "fleet-get-input", {}, ctx);
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		return result.ok ? json(result.data) : result.response;
	}
	if (action === "input" && req.method === "POST") {
		const body = await jsonBody(req);
		if (!body || typeof body.requestId !== "string" || typeof body.answer !== "string") {
			return json({ error: "requestId and answer are required" }, 400);
		}
		const requestId = body.requestId;
		const answer = body.answer;
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		const result = await ctx.fleet.mutateWorker(id,
			() => dispatchCmd(id, "fleet-answer-input", { requestId, answer }, ctx));
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		return result.ok ? json({ ok: true }) : result.response;
	}
	if ((action === "message" || action === "interrupt") && req.method === "POST") {
		const body = await jsonBody(req);
		if (!body) return json({ error: "invalid json body" }, 400);
		const text = body.text;
		if (action === "message" && (typeof text !== "string" || !text.trim())) {
			return json({ error: "text is required" }, 400);
		}
		if (action === "interrupt" && text !== undefined && (typeof text !== "string" || !text.trim())) {
			return json({ error: "text must be nonblank" }, 400);
		}
		if (action === "message" && body.mode !== "start" && body.mode !== "steer" && body.mode !== "follow_up") {
			return json({ error: "invalid message mode" }, 400);
		}
		if (action === "interrupt" && body.clearQueue !== undefined && typeof body.clearQueue !== "boolean") {
			return json({ error: "clearQueue must be boolean" }, 400);
		}
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		const result = await ctx.fleet.mutateWorker(id, () =>
			dispatchCmd(id, action === "message" ? "fleet-message" : "fleet-interrupt",
				{ ...(text === undefined ? {} : { text: text as string }), ...(action === "message" ? { messageMode: body.mode as "start" | "steer" | "follow_up" } : { clearQueue: body.clearQueue as boolean | undefined }) }, ctx));
		if (!stillAllowed()) return json({ error: "session membership changed" }, 409);
		return result.ok ? json({ ok: true, scheduled: true, operationId: pick(result.data, "operationId") }) : result.response;
	}
	return json({ error: "not found" }, 404);
}
