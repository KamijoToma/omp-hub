/**
 * HTTP API (docs/protocol.md §3): machine/session registry for the web UI.
 * Everything except `/api/health` requires `Authorization: Bearer <HUB_TOKEN>`.
 */
import type { AgentRegistry } from "./agents";
import { derivePublicBase, type Config } from "./config";
import type { SessionStore } from "./sessions";

export interface ApiContext {
	readonly cfg: Config;
	readonly sessions: SessionStore;
	readonly agents: AgentRegistry;
}

const SESSION_PATH_RE = /^\/api\/sessions\/([^/]+)$/;
const STOP_PATH_RE = /^\/api\/sessions\/([^/]+)\/stop$/;

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

	return json({ error: "not found" }, 404);
}

async function createSession(req: Request, ctx: ApiContext): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch {
		return json({ error: "invalid json body" }, 400);
	}
	if (parsed === null || typeof parsed !== "object") return json({ error: "invalid json body" }, 400);
	const body = parsed as Record<string, unknown>;

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
