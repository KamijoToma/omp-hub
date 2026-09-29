/**
 * Daemon-side fleet proxy (protocol 0.8.0, "Fleet proxy").
 *
 * A superagent child reaches the hub API through its parent: the supervisor
 * hands each `fleet-req` here, this module enforces the path whitelist (the
 * security boundary -- the child is untrusted input), strips the `superagent`
 * recursion flag, and forwards the call with the daemon's own `HUB_TOKEN`.
 * Pure and dependency-injected so tests run without a hub.
 */

/**
 * Whitelist check (protocol 0.8.0). The query string is ignored (the
 * pathname must match); ids are exactly one path segment. Everything else --
 * other methods, hub control routes, nested resources -- is denied.
 */
export function isAllowedFleetPath(method: string, rawPath: string): boolean {
	let pathname: string;
	try {
		pathname = new URL(rawPath, "http://fleet.invalid").pathname;
	} catch {
		return false;
	}
	const segments = pathname.split("/").filter(segment => segment.length > 0);
	if (segments[0] !== "api") return false;
	const [, collection, id, action] = segments;
	// A trailing slash never rewrites an exact route into an id-less one
	// (POST /api/sessions/ is the denied misspelling of POST /api/sessions).
	const exact = pathname !== "/api/" && !pathname.endsWith("/");
	switch (method) {
		case "GET":
			if (exact && segments.length === 2) return collection === "machines" || collection === "sessions";
			// GET /api/sessions/:id -- exactly one id segment.
			return segments.length === 3 && collection === "sessions" && typeof id === "string" && id.length > 0;
		case "POST":
			if (exact && segments.length === 2) return collection === "sessions" || collection === "notices";
			if (segments.length === 4 && collection === "sessions" && typeof id === "string" && id.length > 0) {
				return action === "stop" || action === "prompt";
			}
			return false;
		default:
			return false;
	}
}

/**
 * Recursion guard (protocol 0.8.0): a `POST /api/sessions` body with
 * `superagent: true` is rewritten to `false` -- fleet sessions spawn only
 * plain sessions. Shallow copy; the caller's body is never mutated.
 */
export function stripFleetSuperagent(body: unknown): unknown {
	if (typeof body !== "object" || body === null) return body;
	const copy = { ...(body as Record<string, unknown>) };
	delete copy.superagent;
	return copy;
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
	log(message: string): void;
	/** Injectable for tests; defaults to global fetch. */
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Proxy fetch timeout (protocol 0.8.0). */
const FLEET_FETCH_TIMEOUT_MS = 15_000;

/**
 * Serve one fleet request: whitelist gate before any network I/O, superagent
 * stripping on session starts, then a token-authenticated hub fetch. Transport
 * failures become `{ok:false}`; HTTP error statuses replay as
 * `{ok:true, status, body}` -- the tool layer turns them into tool errors.
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
	const isSessionStart = method === "POST" && pathname === "/api/sessions";
	const body = isSessionStart ? stripFleetSuperagent(request.body) : request.body;

	const doFetch = deps.fetch ?? fetch;
	try {
		const reply = await doFetch(`${deps.hubBase}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${deps.token}`,
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
