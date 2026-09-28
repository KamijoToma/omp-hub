/**
 * Agent channel (docs/protocol.md §2) — one WebSocket per wrapper daemon.
 *
 * Registration, heartbeat watchdog, ping/pong, session report ingestion and
 * `start`/`stop` dispatch back to a named machine.
 */
import { derivePublicBase, type Config } from "./config";
import { log } from "./log";
import { isTerminalStatus, randomId, type SessionLinks, type SessionStatus, type SessionStore } from "./sessions";

export interface MachineRecord {
	machineId: string;
	name: string;
	connected: boolean;
	connectedAt: number;
	/** live + starting sessions on this machine. */
	sessionCount: number;
	/** Agent-reported temp directory (`hello.tmpdir`); absent from pre-0.3.0 agents. */
	tmpdir?: string;
}

export interface AgentSocketData {
	kind: "agent";
	/** Set by `hello`; null until then. */
	machineId: string | null;
	/** Public origin of the agent's own upgrade request; echoed in `welcome`. */
	httpBase: string;
	wsBase: string;
}

/** Structural socket surface — Bun's `ServerWebSocket` satisfies it. */
export interface AgentSocket {
	readonly data: AgentSocketData;
	send(data: string): number;
	close(code?: number, reason?: string): void;
}

/** Structural server surface for the upgrade handshake. */
export interface AgentUpgradeServer {
	upgrade(req: Request, options: { data: AgentSocketData }): boolean;
}

/** hub → agent frames (protocol §2). */
export type AgentCommand =
	| { t: "welcome"; relayUrl: string; webUrl: string }
	| {
			t: "start";
			id: string;
			cwd: string;
			name?: string;
			prompt?: string;
			/** Resume an existing omp session file instead of minting a new one. */
			sessionFile?: string;
			/** Fleet-operator session (protocol §2): the child registers the fleet tools. */
			superagent?: boolean;
			relayUrl: string;
			webUrl: string;
	  }
	| { t: "stop"; id: string; reason?: string }
	| { t: "ping"; ts: number }
	| ({ t: "cmd" } & CmdRequest)
	| { t: "usage-req"; reqId: string; method: "GET" | "HEAD" | "POST"; path: string; bodyB64?: string };

/** Session commands a session child answers (protocol §2 "Session commands"). */
export type SessionCmdName =
	| "get-state"
	| "get-context"
	| "set-model"
	| "set-thinking"
	| "get-tree"
	| "navigate-tree"
	| "compact"
	| "shake"
	| "handoff"
	| "retry"
	| "loop"
	| "goal"
	| "set-extended-context"
	| "clear-context"
	| "rename"
	| "generate-title"
	| "upload-file"
	| "prompt";

/** Machine-level commands the daemon answers itself (protocol §2 "Machine commands"). */
export type MachineCmdName = "list-dir" | "list-profiles" | "list-sessions";

/** Every `cmd` name on the agent channel. */
export type CmdName = SessionCmdName | MachineCmdName;

/** `loop` limiter: a positive iteration count or a positive time budget (contract §1). */
export type CmdLoopLimit = { iterations: number } | { durationMs: number };

/** `loop` shell condition evaluated between iterations (contract §1). */
export type CmdLoopCondition = { command: string; until: boolean };

/** `cmd` payload; `reqId` correlates the agent's `cmd-result`. */
export interface CmdRequest {
	/** Target session id; absent for machine-level commands. */
	id?: string;
	reqId: string;
	cmd: CmdName;
	/** `list-dir` target directory; omitted lists the agent user's home. */
	path?: string;
	/** `list-sessions` project filter; omitted lists every project. */
	cwd?: string;
	/** `list-sessions` across every omp profile; entries carry `profile` (protocol §2). */
	allProfiles?: boolean;
	/** `upload-file` client-supplied file name, or `rename` target name (protocol §2). */
	name?: string;
	/** `upload-file` payload, base64 (the `/agent` channel speaks JSON TEXT only). */
	dataB64?: string;
	provider?: string;
	modelId?: string;
	/** `set-model` target role; omitted means `"default"` (protocol §2). */
	role?: string;
	/** `set-model`: persist a non-default role assignment (default true). */
	persist?: boolean;
	/** `navigate-tree` target entry (protocol §2). */
	entryId?: string;
	/** `navigate-tree`: build a branch summary (default false). */
	summarize?: boolean;
	level?: string;
	/** `compact` free-form instructions (contract §1). */
	instructions?: string;
	/** `compact` mode name; the agent validates it against the SDK's compact modes. */
	mode?: string;
	/** `loop`/`goal` state-machine action. */
	action?: string;
	/** `goal` objective text (set/replace). */
	objective?: string;
	/** `goal` token budget for the `budget` action (≥ 0). */
	tokenBudget?: number;
	/** `loop` prompt submitted on each iteration. */
	prompt?: string;
	/** `loop` iteration/duration limiter. */
	limit?: CmdLoopLimit;
	/** `loop` continue/halt shell condition. */
	condition?: CmdLoopCondition;
	/** `set-extended-context` target state; omitted toggles (contract §1). */
	enabled?: boolean;
	/** `prompt` message text delivered to the session (protocol §2). */
	text?: string;
}

/** Settlement of one `sendCmd`; failures travel through `error`, the promise never rejects. */
export type CmdResult = { ok: true; data: unknown } | { ok: false; error: string };

/** `c_` + 10 base36 characters from a CSPRNG. */
export function newCmdReqId(): string {
	return randomId("c_");
}

/** Heartbeat expected every 15 s; two consecutive misses mark the agent offline. */
const HB_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const PING_INTERVAL_MS = 30_000;

type Frame = Record<string, unknown>;

interface Connection {
	ws: AgentSocket;
	machineId: string;
	version: string;
	connectedAt: number;
	lastHb: number;
}

/** One live agent connection, handed over between hub cores on hot reload. */
export interface AdoptedConnection {
	ws: AgentSocket;
	machineId: string;
	version: string;
	connectedAt: number;
	lastHb: number;
}

/** One in-flight `cmd`, keyed by `reqId` until the agent answers or the timeout fires. */
interface PendingCmd {
	machineId: string;
	timer: Timer;
	resolve: (result: CmdResult) => void;
}

interface MachineState {
	machineId: string;
	name: string;
	connectedAt: number;
	connected: boolean;
	/** Reported by `hello`; null until then and for pre-0.3.0 agents. */
	tmpdir: string | null;
}

/** Tolerant `hb.sessions` parse: a malformed payload reads as "not reported". */
function parseHbSessions(raw: unknown): Map<string, SessionStatus> | null {
	if (!Array.isArray(raw)) return null;
	const statuses = new Map<string, SessionStatus>();
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { id?: unknown; status?: unknown };
		if (typeof candidate.id !== "string" || candidate.id === "") continue;
		if (candidate.status !== "starting" && candidate.status !== "live" && candidate.status !== "exited" && candidate.status !== "failed") {
			continue;
		}
		statuses.set(candidate.id, candidate.status);
	}
	return statuses;
}

function asFrame(raw: string): Frame | null {
	try {
		const value: unknown = JSON.parse(raw);
		return value !== null && typeof value === "object" ? (value as Frame) : null;
	} catch {
		return null;
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseLinks(value: unknown): SessionLinks | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const raw = value as Frame;
	const full = str(raw.full);
	const view = str(raw.view);
	const web = str(raw.web);
	const webView = str(raw.webView);
	if (!full || !view || !web || !webView) return undefined;
	return { full, view, web, webView };
}

export class AgentRegistry {
	readonly #cfg: Config;
	readonly #sessions: SessionStore;
	readonly #machines = new Map<string, MachineState>();
	readonly #connections = new Map<string, Connection>();
	readonly #pending = new Map<string, PendingCmd>();
	#watchdog: Timer | null = null;
	#pinger: Timer | null = null;

	constructor(cfg: Config, sessions: SessionStore) {
		this.#cfg = cfg;
		this.#sessions = sessions;
	}

	/** Starts the heartbeat watchdog and the ping ticker. */
	start(): void {
		this.#watchdog ??= setInterval(() => this.#sweep(), WATCHDOG_INTERVAL_MS);
		this.#pinger ??= setInterval(() => this.#pingAll(), PING_INTERVAL_MS);
	}

	stop(): void {
		if (this.#watchdog !== null) clearInterval(this.#watchdog);
		if (this.#pinger !== null) clearInterval(this.#pinger);
		this.#watchdog = null;
		this.#pinger = null;
	}

	/** `GET /agent` with `Authorization: Bearer <HUB_TOKEN>`. */
	handleUpgrade(req: Request, server: AgentUpgradeServer): Response | undefined {
		const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
		if (this.#cfg.token === "" || match?.[1] !== this.#cfg.token) {
			return new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
		const base = derivePublicBase(req, this.#cfg);
		const data: AgentSocketData = {
			kind: "agent",
			machineId: null,
			httpBase: base.httpBase,
			wsBase: base.wsBase,
		};
		if (server.upgrade(req, { data })) return undefined;
		return new Response("websocket upgrade required", { status: 426 });
	}

	handleMessage(ws: AgentSocket, message: string | Uint8Array | ArrayBuffer): void {
		if (typeof message !== "string") return; // the agent channel speaks JSON TEXT only
		const frame = asFrame(message);
		if (!frame) {
			ws.close(4000, "invalid frame");
			return;
		}
		if (frame.t === "hello") {
			this.#hello(ws, frame);
			return;
		}
		const machineId = ws.data.machineId;
		if (machineId === null) {
			ws.close(4000, "hello required");
			return;
		}
		const conn = this.#connections.get(machineId);
		if (!conn || conn.ws !== ws) {
			ws.close(4000, "hello required");
			return;
		}
		switch (frame.t) {
			case "hb": {
				conn.lastHb = Date.now();
				this.#reconcileSessions(conn, frame.sessions);
				return;
			}
			case "pong":
				// Recorded for observability only: pong never replaces hb.
				return;
			case "session-ready": {
				const id = str(frame.id);
				if (!id) return;
				const links = parseLinks(frame.links);
				const pid = num(frame.pid);
				this.#sessions.markReady(id, {
					sessionFile: str(frame.sessionFile),
					pid: pid === undefined ? undefined : Math.trunc(pid),
					links,
				});
				return;
			}
			case "session-error": {
				const id = str(frame.id);
				if (!id) return;
				this.#sessions.markFailed(id, str(frame.error) ?? "session failed");
				return;
			}
			case "session-exit": {
				const id = str(frame.id);
				if (!id) return;
				this.#sessions.markExited(id, str(frame.reason) ?? "session exited");
				return;
			}
			case "session-activity": {
				// Malformed samples are dropped, never guessed (protocol §2).
				const id = str(frame.id);
				if (!id || typeof frame.working !== "boolean" || typeof frame.inputRequired !== "boolean") return;
				this.#sessions.setActivity(id, {
					working: frame.working,
					inputRequired: frame.inputRequired,
					// §2 `handoff` bit; absent on older agents and cleared by the next
					// sample once generation settles (each sample is the full truth).
					...(frame.handoff === true ? { handoff: true } : {}),
				});
				// §2 `name`: the agent-side SDK session name (auto-titles included);
				// the registry label follows it like a `rename`. Absent/blank leaves
				// the label untouched — older agents never send the field.
				const name = str(frame.name);
				if (name) this.#sessions.rename(id, name);
				return;
			}
			case "cmd-result": {
				const reqId = str(frame.reqId);
				if (!reqId) return;
				const pending = this.#pending.get(reqId);
				if (!pending || pending.machineId !== machineId) return; // stale or another machine's
				this.#pending.delete(reqId);
				clearTimeout(pending.timer);
				if (frame.ok === true) {
					pending.resolve({ ok: true, data: frame.data });
				} else {
					pending.resolve({ ok: false, error: str(frame.error) ?? "command failed" });
				}
				return;
			}
			case "usage-res": {
				const reqId = str(frame.reqId);
				if (!reqId) return;
				const pending = this.#pending.get(reqId);
				if (!pending || pending.machineId !== machineId) return;
				this.#pending.delete(reqId);
				clearTimeout(pending.timer);
				if (frame.ok === true) {
					pending.resolve({ ok: true, data: frame });
				} else {
					pending.resolve({ ok: false, error: str(frame.error) ?? "usage request failed" });
				}
				return;
			}
			default:
				return; // forward-compatible: unknown frames are ignored
		}
	}

	handleClose(ws: AgentSocket): void {
		const machineId = ws.data.machineId;
		if (machineId === null) return;
		const conn = this.#connections.get(machineId);
		// Superseded by a newer socket, or already taken offline by the watchdog.
		if (!conn || conn.ws !== ws) return;
		this.#connections.delete(machineId);
		this.#failPending(machineId, "agent disconnected");
		const machine = this.#machines.get(machineId);
		if (machine) machine.connected = false;
		const exited = this.#sessions.exitSessionsFor(machineId, "agent disconnected");
		log.info(`machine ${machineId}: agent disconnected (${exited.length} session(s) exited)`);
	}

	/** Sends one command frame; false when the agent is offline or the write fails. */
	send(machineId: string, command: AgentCommand): boolean {
		const conn = this.#connections.get(machineId);
		if (!conn) return false;
		try {
			conn.ws.send(JSON.stringify(command));
			return true;
		} catch (error) {
			log.warn(`machine ${machineId}: send failed (${error instanceof Error ? error.message : String(error)})`);
			return false;
		}
	}

	/**
	 * One `cmd` round trip (protocol §2 "Session commands"). Settles with
	 * `{ok:false, error}` when the agent is offline, the write fails, the agent
	 * disconnects, or the agent stays silent for `cmdTimeoutMs`; never rejects.
	 */
	sendCmd(machineId: string, frame: CmdRequest): Promise<CmdResult> {
		const conn = this.#connections.get(machineId);
		if (!conn) return Promise.resolve({ ok: false, error: "agent offline" });
		const { promise, resolve } = Promise.withResolvers<CmdResult>();
		const pending: PendingCmd = {
			machineId,
			resolve,
			timer: setTimeout(() => {
				this.#pending.delete(frame.reqId);
				resolve({ ok: false, error: "cmd timeout" });
			}, this.#cfg.cmdTimeoutMs),
		};
		this.#pending.set(frame.reqId, pending);
		try {
			conn.ws.send(JSON.stringify({ t: "cmd", ...frame } satisfies AgentCommand));
		} catch (error) {
			this.#pending.delete(frame.reqId);
			clearTimeout(pending.timer);
			log.warn(`machine ${machineId}: cmd send failed (${error instanceof Error ? error.message : String(error)})`);
			resolve({ ok: false, error: "agent offline" });
		}
		return promise;
	}

	/**
	 * One machine-level `usage-req` round trip (protocol §2). Same settlement
	 * contract as {@link sendCmd}: settles with `{ok:false, error}` when the
	 * agent is offline, the write fails, the agent disconnects, or the agent
	 * stays silent for `cmdTimeoutMs`; never rejects. On success `data` is the
	 * agent's `usage-res` frame (`status`, optional `contentType`/`bodyB64`).
	 */
	sendUsageRequest(machineId: string, method: "GET" | "HEAD" | "POST", path: string, bodyB64?: string, profile?: string): Promise<CmdResult> {
		const conn = this.#connections.get(machineId);
		if (!conn) return Promise.resolve({ ok: false, error: "agent offline" });
		const reqId = newCmdReqId();
		const { promise, resolve } = Promise.withResolvers<CmdResult>();
		const pending: PendingCmd = {
			machineId,
			resolve,
			timer: setTimeout(() => {
				this.#pending.delete(reqId);
				resolve({ ok: false, error: "usage timeout" });
			}, this.#cfg.cmdTimeoutMs),
		};
		this.#pending.set(reqId, pending);
		try {
			conn.ws.send(JSON.stringify({
				t: "usage-req",
				reqId,
				method,
				path,
				...(bodyB64 === undefined ? {} : { bodyB64 }),
				...(profile === undefined ? {} : { profile }),
			} satisfies AgentCommand));
		} catch (error) {
			this.#pending.delete(reqId);
			clearTimeout(pending.timer);
			log.warn(`machine ${machineId}: usage send failed (${error instanceof Error ? error.message : String(error)})`);
			resolve({ ok: false, error: "agent offline" });
		}
		return promise;
	}

	getMachine(machineId: string): MachineRecord | undefined {
		return this.#record(this.#machines.get(machineId));
	}

	/** Version reported by `hello` ("test" in tests, "unknown" for pre-0.2.0 agents); null when offline. */
	agentVersion(machineId: string): string | null {
		return this.#connections.get(machineId)?.version ?? null;
	}

	isOnline(machineId: string): boolean {
		return this.#connections.has(machineId);
	}

	/** Settles every pending command of a machine whose socket is gone or replaced. */
	#failPending(machineId: string, error: string): void {
		for (const [reqId, pending] of [...this.#pending]) {
			if (pending.machineId !== machineId) continue;
			this.#pending.delete(reqId);
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, error });
		}
	}

	/** Machines stay listed with `connected: false` until hub restart. */
	listMachines(): MachineRecord[] {
		const records: MachineRecord[] = [];
		for (const machine of this.#machines.values()) {
			const record = this.#record(machine);
			if (record) records.push(record);
		}
		return records;
	}

	/** Known machines with their live sockets removed — the hot-reload handover. */
	drainMachines(): MachineRecord[] {
		const machines = this.listMachines();
		this.#machines.clear();
		return machines;
	}

	/** Re-registers machines handed over by a previous hub core (hot reload). */
	adoptMachines(records: readonly MachineRecord[]): void {
		for (const record of records) {
			this.#machines.set(record.machineId, {
				machineId: record.machineId,
				name: record.name,
				connectedAt: record.connectedAt,
				connected: record.connected,
				tmpdir: record.tmpdir ?? null,
			});
		}
	}

	/** Live agent sockets, detached from this registry — the hot-reload handover. */
	drainConnections(): AdoptedConnection[] {
		const connections = [...this.#connections.values()];
		this.#connections.clear();
		return connections;
	}

	/** Re-registers connections drained from a previous hub core (hot reload). */
	adoptConnections(connections: readonly AdoptedConnection[]): void {
		for (const connection of connections) {
			this.#connections.set(connection.machineId, { ...connection });
		}
	}

	/**
	 * Upgrade-restart reconcile (protocol §3): heartbeats carry the daemon's
	 * child list, so snapshot-restored records the daemon no longer knows about
	 * (its own restart, a lost child) flip to a terminal state instead of
	 * staying `live` forever. Only records created before this agent connection
	 * took part — anything started afterwards follows the normal flow, and an
	 * absent id is only meaningful once this connection has children to report.
	 */
	#reconcileSessions(conn: Connection, reported: unknown): void {
		const statuses = parseHbSessions(reported);
		if (statuses === null) return;
		for (const record of this.#sessions.list()) {
			if (record.machineId !== conn.machineId || isTerminalStatus(record.status)) continue;
			if (record.startedAt >= conn.connectedAt) continue;
			const status = statuses.get(record.id);
			if (status === undefined) {
				this.#sessions.markExited(record.id, "agent heartbeat: no such child");
			} else if (status === "exited") {
				this.#sessions.markExited(record.id, "agent heartbeat");
			} else if (status === "failed") {
				this.#sessions.markFailed(record.id, "agent heartbeat");
			}
		}
	}

	#record(machine: MachineState | undefined): MachineRecord | undefined {
		if (!machine) return undefined;
		return {
			machineId: machine.machineId,
			name: machine.name,
			connected: machine.connected,
			connectedAt: machine.connectedAt,
			sessionCount: this.#sessions.countActiveFor(machine.machineId),
			tmpdir: machine.tmpdir ?? undefined,
		};
	}


	#hello(ws: AgentSocket, frame: Frame): void {
		if (ws.data.machineId !== null) {
			ws.close(4000, "re-hello");
			return;
		}
		const machineId = str(frame.machineId);
		const name = str(frame.name);
		if (!machineId || !name) {
			ws.close(4000, "hello requires machineId and name");
			return;
		}
		const version = str(frame.version) ?? "unknown";
		const tmpdir = str(frame.tmpdir) ?? null;
		const now = Date.now();

		const previous = this.#connections.get(machineId);
		if (previous && previous.ws !== ws) {
			this.#connections.delete(machineId);
			this.#failPending(machineId, "agent disconnected");
			const exited = this.#sessions.exitSessionsFor(machineId, "agent replaced");
			log.warn(`machine ${machineId}: replaced by a new connection (${exited.length} session(s) exited)`);
			try {
				previous.ws.close(4000, "agent replaced");
			} catch {
				// Already closing.
			}
		}

		ws.data.machineId = machineId;
		const machine = this.#machines.get(machineId);
		if (machine) {
			machine.name = name;
			machine.connected = true;
			machine.connectedAt = now;
			machine.tmpdir = tmpdir;
		} else {
			this.#machines.set(machineId, { machineId, name, connectedAt: now, connected: true, tmpdir });
		}
		this.#connections.set(machineId, { ws, machineId, version, connectedAt: now, lastHb: now });

		const welcome: AgentCommand = { t: "welcome", relayUrl: ws.data.wsBase, webUrl: ws.data.httpBase };
		try {
			ws.send(JSON.stringify(welcome));
		} catch {
			// The socket died between upgrade and hello; close() will clean up.
		}
		log.info(`machine ${machineId} ("${name}", agent ${version}) connected`);
	}

	#sweep(): void {
		const now = Date.now();
		for (const conn of [...this.#connections.values()]) {
			const silence = now - conn.lastHb;
			if (silence < HB_TIMEOUT_MS) continue;
			log.warn(`machine ${conn.machineId}: no heartbeat for ${Math.round(silence / 1000)}s — marking offline`);
			this.#offline(conn, "agent lost");
		}
	}

	#pingAll(): void {
		const ts = Date.now();
		for (const conn of this.#connections.values()) {
			try {
				conn.ws.send(JSON.stringify({ t: "ping", ts } satisfies AgentCommand));
			} catch {
				// Silently skip; the heartbeat watchdog handles doomed sockets.
			}
		}
	}

	/** Drops the connection (machine stays listed) and exits its sessions. */
	#offline(conn: Connection, reason: string): void {
		if (this.#connections.get(conn.machineId)?.ws !== conn.ws) return;
		this.#connections.delete(conn.machineId);
		this.#failPending(conn.machineId, "agent offline");
		const machine = this.#machines.get(conn.machineId);
		if (machine) machine.connected = false;
		const exited = this.#sessions.exitSessionsFor(conn.machineId, reason);
		try {
			conn.ws.close(4000, reason);
		} catch {
			// Already closing.
		}
		log.warn(`machine ${conn.machineId}: offline (${reason}); ${exited.length} session(s) exited`);
	}
}
