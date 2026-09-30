/**
 * Daemon-side fleet proxy. The child never gets the hub token or chooses its
 * fleet identity: the supervisor supplies the actual child session id.
 */

/** Only namespace-scoped fleet routes may cross this trust boundary. */
export function isAllowedFleetPath(method: string, rawPath: string): boolean {
	if (!rawPath.startsWith("/api/fleet/") || rawPath.startsWith("//") || rawPath.includes("\\")) return false;
	let url: URL;
	try {
		url = new URL(rawPath, "http://fleet.invalid");
	} catch {
		return false;
	}
	if (url.origin !== "http://fleet.invalid" || url.hash || url.pathname !== rawPath.split("?")[0] || url.pathname.endsWith("/")) return false;
	const segments = url.pathname.split("/");
	if (segments[1] !== "api" || segments[2] !== "fleet") return false;
	const [, , , resource, id, action] = segments;
	if (segments.length >= 5 && resource === "sessions" && (!id || !/^s_[A-Za-z0-9_-]+$/.test(id))) return false;
	if (url.search && !(method === "GET" && segments.length === 6 && resource === "sessions" &&
		(action === "messages" || action === "search"))) return false;
	if (url.search && [...url.searchParams.keys()].some(key =>
		action === "search" ? !["query", "from", "to", "cursor", "limit", "roles", "toolNames", "sources", "fields"].includes(key)
			: key !== "cursor" && key !== "limit")) return false;
	if (method === "GET") {
		if (segments.length === 4) return resource === "machines" || resource === "sessions" || resource === "events";
		if (segments.length === 5) return resource === "sessions";
		return segments.length === 6 && resource === "sessions" && ["messages", "search", "input"].includes(action!);
	}
	if (method !== "POST") return false;
	if (segments.length === 4) return resource === "sessions" || resource === "notices" || resource === "search";
	if (segments.length !== 6) return false;
	if (resource === "events") return action === "ack" && !!id && /^[A-Za-z0-9_-]+$/.test(id);
	return resource === "sessions" && ["claim", "stop", "message", "interrupt", "input", "watch", "message-context", "query"].includes(action!);
}

/** A session start never carries owner, namespace, or superagent identity from a child. */
function permittedStartFields(body: unknown): unknown {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
	const { machineId, cwd, name, prompt, profile, forkFrom } = body as Record<string, unknown>;
	return {
		machineId,
		cwd,
		...(name === undefined ? {} : { name }),
		...(prompt === undefined ? {} : { prompt }),
		...(profile === undefined ? {} : { profile }),
		...(forkFrom === undefined ? {} : { forkFrom }),
	};
}

/** Hub URL for HTTP fetches: the `--hub` value with the ws scheme upgraded. */
export function hubHttpBase(hubUrl: string): string {
	const base = hubUrl.startsWith("ws://")
		? `http://${hubUrl.slice("ws://".length)}`
		: hubUrl.startsWith("wss://")
			? `https://${hubUrl.slice("wss://".length)}`
			: hubUrl;
	return base.replace(/\/+$/, "");
}

export interface FleetProxyRequest {
	method: string;
	path: string;
	body?: unknown;
}

/** Same result shape the child's FleetResult replays verbatim. */
export type FleetProxyResult = { ok: true; status: number; body?: unknown } | { ok: false; error: string };

export interface FleetProxyDeps {
	/** HTTP base of the hub (see {@link hubHttpBase}). */
	hubBase: string;
	token: string;
	/** Trusted session id from the supervisor (never child IPC). */
	ownerId: string;
	log(message: string): void;
	/** Injectable for tests; defaults to global fetch. */
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Bound the daemon's hub fetch independently of a child's tool timeout. */
const FLEET_FETCH_TIMEOUT_MS = 15_000;

/**
 * Whitelist before network I/O, strip caller identity and attach the trusted
 * owner header. HTTP failures replay to the tool layer with their status.
 */
export async function handleFleetRequest(request: FleetProxyRequest, deps: FleetProxyDeps): Promise<FleetProxyResult> {
	const { method, path } = request;
	const denied = (): FleetProxyResult => {
		deps.log(`fleet ${method} ${path} -> fleet: path not allowed`);
		return { ok: false, error: "fleet: path not allowed" };
	};
	if (!isAllowedFleetPath(method, path)) return denied();

	let pathname: string;
	try {
		pathname = new URL(path, "http://fleet.invalid").pathname;
	} catch {
		return denied();
	}
	const isSessionStart = method === "POST" && pathname === "/api/fleet/sessions";
	// Do not forward caller-supplied identity fields on any route. Other routes
	// likewise accept only their documented JSON parameters.
	const input = request.body as Record<string, unknown> | undefined;
	let body: unknown;
	if (isSessionStart) body = permittedStartFields(request.body);
	else if (method === "POST" && input && typeof input === "object" && !Array.isArray(input)) {
		const keys = pathname.endsWith("/query") ? ["sql"] : pathname.endsWith("/message") ? ["text", "mode"]
			: pathname.endsWith("/interrupt") ? ["text", "clearQueue"]
			: pathname.endsWith("/input") ? ["requestId", "answer"]
			: pathname.endsWith("/message-context") ? ["messageId", "before", "after", "leafId", "toolCallId", "contentCursor"]
			: pathname === "/api/fleet/search" ? ["query", "from", "to", "cursor", "limit", "sessionIds", "machineIds", "cwd", "roles", "toolNames", "sources", "fields"]
			: pathname === "/api/fleet/notices" ? ["message", "urgency", "sessionId"] : [];
		body = Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
	} else body = method === "GET" ? undefined : request.body;

	const doFetch = deps.fetch ?? fetch;
	try {
		const reply = await doFetch(`${deps.hubBase}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${deps.token}`,
				"X-Fleet-Owner": deps.ownerId,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(FLEET_FETCH_TIMEOUT_MS),
		});
		const text = await reply.text();
		let parsed: unknown;
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		deps.log(`fleet ${method} ${path} -> ${reply.status}`);
		return { ok: true, status: reply.status, ...(parsed === undefined ? {} : { body: parsed }) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		deps.log(`fleet ${method} ${path} -> ${error}`);
		return { ok: false, error };
	}
}
