/**
 * Agent channel (docs/protocol.md §2) — one WebSocket per wrapper daemon.
 *
 * Registration, heartbeat watchdog, ping/pong, session report ingestion and
 * `start`/`stop` dispatch back to a named machine.
 */
import { derivePublicBase, type Config } from "./config";
import type { FleetEvent, FleetState } from "./fleet-state";
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
	/** Daemon upgrade restart in flight (protocol §2 `restart-daemon`); absent otherwise. */
	restarting?: true;
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
			/** Named omp profile for the session; omitted means the default profile. */
			profile?: string;
			/** Resume an existing omp session file instead of minting a new one. */
			sessionFile?: string;
			/** Fleet-operator session (protocol §2): the child registers the fleet tools. */
			superagent?: boolean;
			/** Fleet operator transcript access mode; never accepted for plain workers. */
			searchMode?: "fleet" | "sql";
			/** Callable-tool whitelist (protocol §2 `start.tools`); omitted means the default set. */
			tools?: string[];
			/** One-shot prewalk hand-off at startup (0.9.0+): true = SDK default target, or an explicit model/role pattern. */
			prewalk?: boolean | string;
			/** One-shot plan-mode hand-off at startup (0.9.0+): true = SDK default target, or an explicit model/role pattern. */
			planYolo?: boolean | string;
			relayUrl: string;
			webUrl: string;
	  }
	| { t: "stop"; id: string; reason?: string }
	| { t: "ping"; ts: number }
	| ({ t: "cmd" } & CmdRequest)
	| { t: "usage-req"; reqId: string; method: "GET" | "HEAD" | "POST"; path: string; bodyB64?: string }
	| { t: "fleet-notification"; id: string; event: FleetEvent }
	| { t: "session-event-ack"; eventId: string };

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
	| "mcp-list"
	| "mcp-add"
	| "mcp-remove"
	| "mcp-set-enabled"
	| "mcp-test"
	| "prompt"
	| "prewalk"
	| "plan"
	| "advisor"
	| "tier"
	| "pause"
	| "cycle-model"
	| "get-settings"
	| "fleet-get-messages"
	| "fleet-search-messages"
	| "fleet-query-messages"
	| "fleet-get-input"
	| "fleet-answer-input"
	| "fleet-message"
	| "fleet-fork-session"
	| "fleet-interrupt"
	| "set-setting";

/** Machine-level commands the daemon itself answers (protocol §2 "Machine commands"). */
export type MachineCmdName = "list-dir" | "list-profiles" | "list-sessions" | "search-sessions" | "read-session-messages" | "search-session-messages" | "query-session-messages" | "get-subscriptions" | "restart-daemon";

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
	/** `list-dir` directory or `read-session-messages` managed session file. */
	path?: string;
	/** `list-sessions` project filter; omitted lists every project. */
	cwd?: string;
	/** `list-sessions` across every omp profile; entries carry `profile` (protocol §2). */
	allProfiles?: boolean;
	/** `get-subscriptions`: one isolated omp profile (omitted means default). */
	profile?: string;
	/** `search-sessions` candidate session files; omitted searches the machine's registry sessions (protocol §2). */
	paths?: string[];
	/** `search-sessions` needle; matched case-insensitively (protocol §2). */
	query?: string;
	/** SQL over one worker's isolated, active-branch transcript projection. */
	sql?: string;
	/** `upload-file` client-supplied file name, or `rename` target name (protocol §2). */
	name?: string;
	/** `upload-file` payload, base64 (the `/agent` channel speaks JSON TEXT only). */
	dataB64?: string;
	/** `mcp-add`/`mcp-remove` config scope; omitted means `"project"` (protocol §2). */
	scope?: string;
	/** `mcp-add` remote server URL (http/sse transport). */
	url?: string;
	/** `mcp-add` remote transport; omitted means `"http"`. */
	transport?: string;
	/** `mcp-add` bearer token folded into the config's Authorization header. */
	token?: string;
	/** `mcp-add` stdio command (exclusive with `url`). */
	command?: string;
	/** `mcp-add` stdio command arguments. */
	args?: string[];
	provider?: string;
	modelId?: string;
	/** `set-model` target role; omitted means `"default"` (protocol §2). */
	role?: string;
	/** `set-model`: persist a non-default role assignment (default true). */
	persist?: boolean;
	/** `set-model` (0.10.0+): clear the role's persisted assignment — auto-selection applies. */
	clearRole?: boolean;
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
	/** `prewalk` target: a role alias (`@smol`) or provider/model pattern (protocol §2, 0.9.0+). */
	target?: string;
	/** `tier` provider family (protocol §2, 0.9.0+). */
	family?: string;
	/** `tier` service tier within the family (protocol §2, 0.9.0+). */
	tier?: string;
	/** `cycle-model` traversal direction; omitted means `"forward"` (protocol §2, 0.9.0+). */
	direction?: string;
	/** `cycle-model` (0.10.0+): cycle the configured role models (`cycleOrder`) instead of the model list. */
	roleCycle?: boolean;
	/** `set-setting` descriptor id (protocol §2, 0.9.0+). */
	settingId?: string;
	/** `set-setting` override value (JSON-safe); `null` clears it (protocol §2, 0.9.0+). */
	value?: unknown;
	/** Fleet message page cursor (an active-branch entry id), or pending UI request identity. */
	cursor?: string;
	/** Fleet message-search time bounds (ISO-8601 timestamps with timezone). */
	from?: string;
	to?: string;
	requestId?: string;
	answer?: string;
	clearQueue?: boolean;
	/** Fleet message page size. */
	pageLimit?: number;
	messageMode?: "start" | "steer" | "follow_up";
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

/**
 * How long a daemon-restart flag may outlive its socket: `restartingSince`
 * until the disconnect that converts it into a `resumePlan`, the plan until
 * the fresh daemon's reconciling heartbeat. Generous against slow child stops
 * (the 12 s stopAll grace) plus reconnect backoff; a daemon that needs longer
 * is not coming back on its own.
 */
const RESTART_FLAG_TTL_MS = 90_000;

type Frame = Record<string, unknown>;

interface Connection {
	ws: AgentSocket;
	machineId: string;
	version: string;
	connectedAt: number;
	lastHb: number;
	/** Sessions present at hello or reissued under the same id; eligible for heartbeat reconciliation. */
	preexistingIds: Set<string>;
}

/** One live agent connection, handed over between hub cores on hot reload. */
export interface AdoptedConnection {
	ws: AgentSocket;
	machineId: string;
	version: string;
	connectedAt: number;
	lastHb: number;
	preexistingIds: Set<string>;
}
export interface FleetRecoveryState {
	events: FleetEvent[];
	owners: string[];
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
	/**
	 * Daemon upgrade restart accepted and the socket still up (protocol §2
	 * `restart-daemon`). Cleared when the socket drops (converting to
	 * `resumePlan`) or by the watchdog TTL — the daemon may have died before
	 * processing the request.
	 */
	restartingSince?: number;
	/**
	 * Session ids alive when the restart was REQUESTED. The daemon stops its
	 * children during the handover, so by the time the fresh daemon connects
	 * the records are already terminal — the disconnect-time snapshot of
	 * "non-terminal records" would always be empty. Filtered by the handover
	 * exit reason when the plan arms, so a session the operator stopped in the
	 * request window stays stopped.
	 */
	resumeIds?: string[];
	/**
	 * Armed when a restarting daemon's connection ends: the request-time
	 * `resumeIds` filtered to sessions the handover itself terminated (or ones
	 * still live). The reconnected daemon's first heartbeat reconciles against
	 * this plan and re-issues same-id starts for children that are gone; the
	 * watchdog TTL covers a daemon that never comes back.
	 */
	resumePlan?: { at: number; ids: string[] };
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

/** `x.y.z` triple of a daemon version; null for unknown or test-only versions. */
export function versionTriple(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Old daemons still proxy unrestricted /api/* fleet requests and are unsafe as operators. */
export function supportsFleetNamespace(version: string | null): boolean {
	if (version === null) return false;
	const triple = versionTriple(version);
	return triple !== null && (triple[0] > 0 || (triple[0] === 0 && triple[1] >= 12));
}

/** Backward paging starts with the newest messages only on 0.13.0+ daemons. */
export function supportsRecentFleetMessages(version: string | null): boolean {
	if (version === null) return false;
	const triple = versionTriple(version);
	return triple !== null && (triple[0] > 0 || (triple[0] === 0 && triple[1] >= 13));
}

/** Message search requires both participants to understand time bounds and backward hit cursors. */
export function supportsFleetMessageSearch(version: string | null): boolean {
	if (version === null) return false;
	const triple = versionTriple(version);
	return triple !== null && (triple[0] > 0 || (triple[0] === 0 && triple[1] >= 14));
}

/** Raw SQL over the isolated transcript projection requires a 0.15.0+ daemon. */
export function supportsFleetSqlQuery(version: string | null): boolean {
	if (version === null) return false;
	const triple = versionTriple(version);
	return triple !== null && (triple[0] > 0 || (triple[0] === 0 && triple[1] >= 15));
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
	readonly #fleet: FleetState;
	readonly #machines = new Map<string, MachineState>();
	readonly #connections = new Map<string, Connection>();
	readonly #pending = new Map<string, PendingCmd>();
	/** Sent this connection; unacked inbox entries replay after reconnect, not on every heartbeat. */
	readonly #fleetDelivered = new Set<string>();
	/** Terminal/unreachable events cannot be source-retried; keep them until SQLite accepts. */
	readonly #pendingDerivedEvents = new Map<string, FleetEvent>();
	readonly #pendingOwnerCleanup = new Set<string>();
	#watchdog: Timer | null = null;
	#pinger: Timer | null = null;
	#stopped = false;
	#nextFleetPruneAt = Date.now() + 60 * 60 * 1000;

	constructor(cfg: Config, sessions: SessionStore, fleet: FleetState) {
		this.#cfg = cfg;
		this.#sessions = sessions;
		this.#fleet = fleet;
	}

	/** Starts the heartbeat watchdog and the ping ticker. */
	start(): void {
		this.#stopped = false;
		this.#watchdog ??= setInterval(() => this.#sweep(), WATCHDOG_INTERVAL_MS);
		this.#pinger ??= setInterval(() => this.#pingAll(), PING_INTERVAL_MS);
	}

	stop(): void {
		this.#stopped = true;
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
				this.#replayFleet(machineId);
				this.retryFleetEvents();
				return;
			}
			case "pong":
				// Recorded for observability only: pong never replaces hb.
				return;
			case "session-ready": {
				const id = str(frame.id);
				const record = id ? this.#sessions.get(id) : undefined;
				if (!record || record.machineId !== machineId || isTerminalStatus(record.status)) return;
				const links = parseLinks(frame.links);
				const pid = num(frame.pid);
				this.#sessions.markReady(record.id, {
					sessionFile: str(frame.sessionFile),
					pid: pid === undefined ? undefined : Math.trunc(pid),
					links,
				});
				return;
			}
			case "session-error": {
				const id = str(frame.id);
				const record = id ? this.#sessions.get(id) : undefined;
				if (!record || record.machineId !== machineId || isTerminalStatus(record.status)) return;
				this.#sessions.markFailed(record.id, str(frame.error) ?? "session failed");
				this.#sessionEnded(record.id, "session_failed", str(frame.eventId));
				return;
			}
			case "session-exit": {
				const id = str(frame.id);
				const record = id ? this.#sessions.get(id) : undefined;
				if (!record || record.machineId !== machineId || isTerminalStatus(record.status)) return;
				this.#sessions.markExited(record.id, str(frame.reason) ?? "session exited");
				this.#sessionEnded(record.id, "session_exited", str(frame.eventId));
				return;
			}
			case "session-activity": {
				// Malformed samples are dropped, never guessed (protocol §2).
				const id = str(frame.id);
				const record = id ? this.#sessions.get(id) : undefined;
				if (!record || record.machineId !== machineId || isTerminalStatus(record.status) ||
					typeof frame.working !== "boolean" || typeof frame.inputRequired !== "boolean") return;
				this.#sessions.setActivity(record.id, {
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
				if (name) this.#sessions.rename(record.id, name);
				return;
			}
			case "session-event": {
				const id = str(frame.id);
				const eventId = str(frame.eventId);
				const kind = str(frame.kind);
				const record = id ? this.#sessions.get(id) : undefined;
				if (!record || record.machineId !== machineId || !eventId || !kind ||
					(kind !== "input_required" && kind !== "input_resolved" && kind !== "turn_finished" &&
					kind !== "operation_failed" && kind !== "session_exited" && kind !== "session_failed")) return;
				const requestId = str(frame.requestId);
				const leafId = str(frame.leafId);
				const operationId = str(frame.operationId);
				const error = str(frame.error);
				const event: FleetEvent = {
					id: eventId,
					sessionId: record.id,
					kind,
					createdAt: Date.now(),
					...(requestId ? { requestId } : {}),
					...(leafId ? { leafId } : {}),
					...(operationId ? { operationId } : {}),
					...(error ? { error: error.slice(0, 2000) } : {}),
				};
				if (!this.#queueFleetEvent(event)) return; // no ack: daemon retries after storage recovers
				try {
					ws.send(JSON.stringify({ t: "session-event-ack", eventId } satisfies AgentCommand));
				} catch {
					// Already persisted. The daemon retries this id after reconnect.
				}
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
		if (this.#stopped) return;
		const machineId = ws.data.machineId;
		if (machineId === null) return;
		const conn = this.#connections.get(machineId);
		// Superseded by a newer socket, or already taken offline by the watchdog.
		if (!conn || conn.ws !== ws) return;
		this.#connections.delete(machineId);
		this.#failPending(machineId, "agent disconnected");
		const plan = this.#armResumePlan(machineId);
		const machine = this.#machines.get(machineId);
		if (machine) machine.connected = false;
		const changed = plan
			? this.#sessions.exitSessionsFor(machineId, "daemon upgrade")
			: this.#sessions.markUnreachableFor(machineId);
		this.#fleetDisconnected(machineId);
		log.info(`machine ${machineId}: agent disconnected (${changed.length} session(s) ${plan ? "exited for upgrade" : "unreachable"})`);
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
	sendCmd(machineId: string, frame: CmdRequest, timeoutMs = this.#cfg.cmdTimeoutMs): Promise<CmdResult> {
		const conn = this.#connections.get(machineId);
		if (!conn) return Promise.resolve({ ok: false, error: "agent offline" });
		const { promise, resolve } = Promise.withResolvers<CmdResult>();
		const pending: PendingCmd = {
			machineId,
			resolve,
			timer: setTimeout(() => {
				this.#pending.delete(frame.reqId);
				resolve({ ok: false, error: "cmd timeout" });
			}, timeoutMs),
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

	/**
	 * Panel-triggered daemon upgrade restart (protocol §2 `restart-daemon`):
	 * arms the restart flag and sends the machine command. The daemon acks
	 * first, then stops its children and self-respawns; the disconnect converts
	 * the flag into a resume plan that the fresh daemon's first heartbeat
	 * replays ({@link #resumePlannedSessions}). A mid-command disconnect still
	 * counts as accepted — the daemon may be restarting after all — while a
	 * definitive refusal (old daemon, timeout) clears the flag.
	 */
	async restartDaemon(machineId: string): Promise<CmdResult> {
		const machine = this.#machines.get(machineId);
		if (!machine) return { ok: false, error: "machine not found" };
		if (machine.restartingSince !== undefined || machine.resumePlan) {
			return { ok: false, error: "daemon restart already in progress" };
		}
		if (!this.isOnline(machineId)) return { ok: false, error: "agent offline" };
		// Snapshot NOW, while the records are still non-terminal: the daemon's
		// stopAll exits every child (session-exit frames) long before the
		// disconnect that arms the plan.
		const resumeIds = this.#sessions
			.list()
			.filter(record => record.machineId === machineId && !isTerminalStatus(record.status))
			.map(record => record.id);
		machine.resumeIds = resumeIds;
		machine.restartingSince = Date.now();
		const result = await this.sendCmd(machineId, { reqId: newCmdReqId(), cmd: "restart-daemon" });
		if (!result.ok && result.error !== "agent disconnected") {
			machine.restartingSince = undefined;
			machine.resumeIds = undefined;
			return result;
		}
		log.info(
			`machine ${machineId}: daemon restart accepted — waiting for the fresh daemon to reconnect (planned resume: ${resumeIds.length} session(s))`,
		);
		return { ok: true, data: { restarting: true } };
	}

	/** Version reported by `hello` ("test" in tests, "unknown" for pre-0.2.0 agents); null when offline. */
	agentVersion(machineId: string): string | null {
		return this.#connections.get(machineId)?.version ?? null;
	}

	isOnline(machineId: string): boolean {
		return this.#connections.has(machineId);
	}

	/** Reissued ids must become reconcile candidates even if terminal at hello. */
	trackReissuedSession(machineId: string, id: string): void {
		this.#connections.get(machineId)?.preexistingIds.add(id);
	}

	/** Remove an acknowledged notification from the connection-local replay fence. */
	forgetFleetDelivery(ownerId: string, eventId: string): void {
		this.#fleetDelivered.delete(`${ownerId}:${eventId}`);
	}

	/** Push an unread fleet event to a scoped subscriber, without exposing collab links. */
	notifyFleet(ownerId: string, event: FleetEvent): boolean {
		const owner = this.#sessions.get(ownerId);
		const worker = this.#sessions.get(event.sessionId);
		if (!owner || !worker || owner.status !== "live" || owner.superagent !== true || !owner.namespaceId) return false;
		if (event.kind !== "namespace_revoked" && owner.namespaceId !== worker.namespaceId) return false;
		const key = `${ownerId}:${event.id}`;
		if (this.#fleetDelivered.has(key)) return true;
		if (!this.send(owner.machineId, { t: "fleet-notification", id: ownerId, event })) return false;
		this.#fleetDelivered.add(key);
		return true;
	}

	#queueFleetEvent(event: FleetEvent): boolean {
		const worker = this.#sessions.get(event.sessionId);
		if (!worker) return true;
		try {
			const namespaceId = this.#fleet.membership(worker.id).namespaceId;
			if (!namespaceId) return true;
			const recipients = this.#fleet.enqueue(event, ownerId => {
				const owner = this.#sessions.get(ownerId);
				return owner?.status === "live" && owner.superagent === true &&
					this.#fleet.membership(ownerId).namespaceId === namespaceId;
			});
			for (const ownerId of recipients) this.notifyFleet(ownerId, event);
			return true;
		} catch (err) {
			log.error(`fleet event ${event.id} could not be persisted: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** Retry derived lifecycle events and owner cleanup after transient fleet-store failures. */
	retryFleetEvents(): void {
		for (const [id, event] of this.#pendingDerivedEvents) {
			if (this.#queueFleetEvent(event)) this.#pendingDerivedEvents.delete(id);
		}
		for (const ownerId of this.#pendingOwnerCleanup) this.#releaseOwner(ownerId);
	}

	drainFleetRecovery(): FleetRecoveryState {
		const state = { events: [...this.#pendingDerivedEvents.values()], owners: [...this.#pendingOwnerCleanup] };
		this.#pendingDerivedEvents.clear();
		this.#pendingOwnerCleanup.clear();
		return state;
	}

	adoptFleetRecovery(state: FleetRecoveryState): void {
		for (const event of state.events) this.#pendingDerivedEvents.set(event.id, event);
		for (const ownerId of state.owners) this.#pendingOwnerCleanup.add(ownerId);
		this.retryFleetEvents();
	}

	#queueDerived(event: FleetEvent): void {
		if (!this.#queueFleetEvent(event)) this.#pendingDerivedEvents.set(event.id, event);
	}

	#releaseOwner(ownerId: string): void {
		try {
			this.#fleet.removeOwner(ownerId);
			this.#pendingOwnerCleanup.delete(ownerId);
			for (const worker of this.#sessions.list()) {
				if (worker.controllerId === ownerId) this.#sessions.applyMembership(worker.id, this.#fleet.membership(worker.id));
			}
		} catch (err) {
			this.#pendingOwnerCleanup.add(ownerId);
			log.error(`fleet controller ${ownerId} could not be released: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	#sessionEnded(id: string, kind: "session_exited" | "session_failed", sourceEventId?: string): void {
		const record = this.#sessions.get(id);
		if (!record) return;
		this.#queueDerived({ id: sourceEventId ?? randomId("e_"), sessionId: id, kind, createdAt: Date.now() });
		if (record.superagent === true) this.#releaseOwner(id);
	}

	#fleetDisconnected(machineId: string): void {
		for (const key of this.#fleetDelivered) {
			const ownerId = key.slice(0, key.indexOf(":"));
			if (this.#sessions.get(ownerId)?.machineId === machineId) this.#fleetDelivered.delete(key);
		}
		for (const record of this.#sessions.list()) {
			if (record.machineId === machineId && record.unreachable) {
				this.#queueDerived({ id: randomId("e_"), sessionId: record.id, kind: "session_unreachable", createdAt: Date.now() });
			}
		}
	}

	#replayFleet(machineId: string): void {
		try {
			for (const owner of this.#sessions.list()) {
				if (owner.machineId !== machineId || owner.superagent !== true || owner.status !== "live") continue;
				for (const event of this.#fleet.events(owner.id)) this.notifyFleet(owner.id, event);
			}
		} catch (err) {
			log.error(`fleet replay for ${machineId} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
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
	 * staying `live` forever. Reconcile only ids present at connection time or
	 * explicitly reissued under that id; new sessions on this connection follow
	 * their normal lifecycle until a subsequent reconnect.
	 */
	#reconcileSessions(conn: Connection, reported: unknown): void {
		const statuses = parseHbSessions(reported);
		if (statuses === null) return;
		// Daemon-restart recovery runs before the retire pass: same-id resumes
		// mint fresh `starting` records this same heartbeat must not retire.
		const machine = this.#machines.get(conn.machineId);
		const plan = machine?.resumePlan;
		let exempt: Set<string> | null = null;
		if (machine && plan) {
			machine.resumePlan = undefined;
			exempt = this.#resumePlannedSessions(conn, plan, statuses);
		}
		for (const record of this.#sessions.list()) {
			if (record.machineId !== conn.machineId || isTerminalStatus(record.status)) continue;
			if (!conn.preexistingIds.has(record.id)) continue;
			// A same-id restart re-arms an old record while this connection stays up.
			// Do not retire it until the new child has had time to appear in heartbeats.
			if (this.#sessions.inRestartGrace(record.id)) continue;
			if (exempt?.has(record.id)) continue;
			const status = statuses.get(record.id);
			if (status === undefined) {
				this.#sessions.markExited(record.id, "agent heartbeat: no such child");
				this.#sessionEnded(record.id, "session_exited");
			} else if (status === "exited") {
				this.#sessions.markExited(record.id, "agent heartbeat");
				this.#sessionEnded(record.id, "session_exited");
			} else if (status === "failed") {
				this.#sessions.markFailed(record.id, "agent heartbeat");
				this.#sessionEnded(record.id, "session_failed");
			} else {
				record.unreachable = undefined;
			}
		}
	}

	/**
	 * Replays an armed daemon-restart resume plan: re-issues same-id `start`s
	 * for sessions that were alive at the disconnect but whose children the
	 * fresh daemon does not report. A child the daemon still has (its restart
	 * frame was lost, the socket merely blipped) is left entirely alone — its
	 * record stays terminal for a manual resume rather than getting corrupted
	 * by a duplicate start.
	 */
	#resumePlannedSessions(
		conn: Connection,
		plan: { at: number; ids: string[] },
		statuses: Map<string, SessionStatus>,
	): Set<string> {
		const reissued = new Set<string>();
		for (const id of plan.ids) {
			const record = this.#sessions.get(id);
			if (!record?.sessionFile) continue;
			if (statuses.get(id) !== undefined) continue;
			if (record.superagent && (!record.namespaceId || !supportsFleetNamespace(conn.version) ||
				(record.searchMode === "sql" && !supportsFleetSqlQuery(conn.version)))) {
				log.warn(`machine ${conn.machineId}: refusing to resume scoped operator ${id} on an incompatible daemon`);
				continue;
			}
			const fresh = this.#sessions.reissue(id);
			if (!fresh?.sessionFile) continue;
			const sent = this.send(conn.machineId, {
				t: "start",
				id: fresh.id,
				cwd: fresh.cwd,
				...(fresh.name ? { name: fresh.name } : {}),
				...(fresh.profile ? { profile: fresh.profile } : {}),
				...(fresh.sessionFile ? { sessionFile: fresh.sessionFile } : {}),
				...(fresh.tools ? { tools: fresh.tools } : {}),
				...(fresh.superagent ? { superagent: true } : {}),
				...(fresh.superagent ? { searchMode: fresh.searchMode ?? "fleet" } : {}),
				relayUrl: conn.ws.data.wsBase,
				webUrl: conn.ws.data.httpBase,
			});
			if (sent) {
				conn.preexistingIds.add(fresh.id);
				reissued.add(fresh.id);
			} else {
				this.#sessions.markFailed(fresh.id, "daemon restart: agent offline");
			}
		}
		if (reissued.size > 0) {
			log.info(`machine ${conn.machineId}: daemon restart resumed ${reissued.size}/${plan.ids.length} session(s) under their old ids`);
		}
		return reissued;
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
			...(machine.restartingSince !== undefined || machine.resumePlan ? { restarting: true as const } : {}),
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
			// The fresh daemon of a restart can connect before the dying daemon's
			// socket tears down — this replacement path, not handleClose, is what
			// runs then, so the resume plan must arm here too.
			const plan = this.#armResumePlan(machineId);
			const changed = plan
				? this.#sessions.exitSessionsFor(machineId, "daemon upgrade")
				: this.#sessions.markUnreachableFor(machineId);
			this.#fleetDisconnected(machineId);
			log.warn(`machine ${machineId}: replaced by a new connection (${changed.length} session(s) ${plan ? "exited for upgrade" : "unreachable"})`);
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
		const preexistingIds = new Set(this.#sessions.list()
			.filter(record => record.machineId === machineId && !isTerminalStatus(record.status))
			.map(record => record.id));
		this.#connections.set(machineId, { ws, machineId, version, connectedAt: now, lastHb: now, preexistingIds });

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
		for (const machine of this.#machines.values()) {
			if (machine.restartingSince !== undefined && now - machine.restartingSince > RESTART_FLAG_TTL_MS) {
				machine.restartingSince = undefined;
				machine.resumeIds = undefined;
				log.warn(`machine ${machine.machineId}: daemon restart flag expired without a disconnect — the daemon never restarted`);
			}
			if (machine.resumePlan && now - machine.resumePlan.at > RESTART_FLAG_TTL_MS) {
				machine.resumePlan = undefined;
				log.warn(`machine ${machine.machineId}: daemon restart resume plan expired — the fresh daemon never reconnected`);
			}
		}
		this.retryFleetEvents();
		if (now >= this.#nextFleetPruneAt) {
			try {
				const known = new Set(this.#sessions.list().map(record => record.id));
				const pruned = this.#fleet.pruneOrphans(known);
				if (pruned > 0) log.info(`pruned ${pruned} orphaned fleet session(s)`);
				this.#nextFleetPruneAt = now + 60 * 60 * 1000;
			} catch (err) {
				log.warn(`fleet pruning failed: ${err instanceof Error ? err.message : String(err)}`);
				this.#nextFleetPruneAt = now + 60_000;
			}
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
		const plan = this.#armResumePlan(conn.machineId);
		const machine = this.#machines.get(conn.machineId);
		if (machine) machine.connected = false;
		const changed = plan
			? this.#sessions.exitSessionsFor(conn.machineId, "daemon upgrade")
			: this.#sessions.markUnreachableFor(conn.machineId);
		try {
			// 1001 (going away), NOT 4000: the agent treats 4000 as fatal and
			// permanently stops reconnecting — right for "agent replaced" (the
			// hello race must not end with two daemons), wrong for a heartbeat
			// timeout, which a live daemon must be able to recover from.
			conn.ws.close(1001, reason);
		} catch {
			// Already closing.
		}
		log.warn(
			`machine ${conn.machineId}: offline (${reason}); ${changed.length} session(s) ${plan ? "exited for upgrade" : "unreachable"}`,
		);
		this.#fleetDisconnected(conn.machineId);
	}

	/**
	 * Converts an armed daemon-restart flag into a resume plan. Called from
	 * every path a restarting daemon's connection can end — graceful close,
	 * watchdog offline, and the `hello` replacement race (the fresh daemon can
	 * connect before the dying one's socket tears down). The id list is the
	 * REQUEST-time snapshot (`resumeIds`): by handover the daemon has already
	 * stopped its children, so their records read terminal with
	 * `exitReason: "daemon upgrade"`. A session exited for any other reason
	 * (operator stop, crash) keeps its terminal state; a still-non-terminal
	 * id resumes as-is. Returns the armed plan, or undefined when no restart
	 * was in flight.
	 */
	#armResumePlan(machineId: string): MachineState["resumePlan"] {
		const machine = this.#machines.get(machineId);
		if (!machine || machine.restartingSince === undefined) return undefined;
		machine.restartingSince = undefined;
		const snapshotted = machine.resumeIds;
		machine.resumeIds = undefined;
		const ids = (snapshotted ?? []).flatMap(id => {
			const record = this.#sessions.get(id);
			if (!record?.sessionFile) return [];
			if (isTerminalStatus(record.status) && record.exitReason !== "daemon upgrade") return [];
			return [record.id];
		});
		const plan = { at: Date.now(), ids };
		machine.resumePlan = plan;
		return plan;
	}
}
