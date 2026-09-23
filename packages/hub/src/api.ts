/**
 * HTTP API (docs/protocol.md §3): machine/session registry for the web UI.
 * Everything except `/api/health` requires `Authorization: Bearer <HUB_TOKEN>`.
 */
import { newCmdReqId, type AgentRegistry, type CmdName, type CmdRequest } from "./agents";
import { derivePublicBase, type Config } from "./config";
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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function authorized(req: Request, cfg: Config): boolean {
	if (cfg.token === "") return true; // open mode (dev only; warned at startup)
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

	return json({ error: "not found" }, 404);
}

async function createSession(req: Request, ctx: ApiContext): Promise<Response> {
	const body = await jsonBody(req);
	if (body === null) return json({ error: "invalid json body" }, 400);

	const machineId = field(body, "machineId");
	if (!machineId) return json({ error: "machineId is required" }, 400);
	const cwd = field(body, "cwd");
	if (!cwd || cwd.trim() === "") return json({ error: "cwd is required" }, 400);

	const machine = ctx.agents.getMachine(machineId);
	if (!machine) return json({ error: "machine not found" }, 404);
	if (!machine.connected) return json({ error: "machine offline" }, 404);

	const record = ctx.sessions.create({
		machineId,
		machineName: machine.name,
		cwd,
		name: field(body, "name"),
	});
	const prompt = field(body, "prompt");
	const base = derivePublicBase(req, ctx.cfg);
	const dispatched = ctx.agents.send(machineId, {
		t: "start",
		id: record.id,
		cwd: record.cwd,
		name: record.name,
		...(prompt === undefined ? {} : { prompt }),
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
	switch (error) {
		case "unknown session":
			return 409;
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
