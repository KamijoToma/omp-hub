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

/** Human-readable message for an unknown thrown value. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
