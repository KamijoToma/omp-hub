/**
 * Hub agent channel client (docs/protocol.md §2).
 *
 * One socket per daemon: `hello` on every (re)open, 15 s heartbeats, `pong` for
 * hub pings, exponential backoff (1 s → 30 s, ±25 % jitter) between attempts.
 * Frames produced while the socket is down are queued and flushed after the next
 * `hello`, so session reports survive a hub restart.
 */

import { tmpdir } from "node:os";
import { errorMessage, type Logger } from "./log";
import type { SessionLinks, SessionStatus } from "./supervisor";

/** Agent release reported in `hello.version`. */
const AGENT_VERSION = "0.3.0";
const HEARTBEAT_MS = 15_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUEUED_FRAMES = 256;
/** Close code the hub uses for protocol violations (e.g. this machineId was replaced). */
const FATAL_CLOSE_CODE = 4000;

export interface WelcomeFrame {
	t: "welcome";
	relayUrl: string;
	webUrl: string;
}

export interface StartFrame {
	t: "start";
	id: string;
	cwd: string;
	name?: string;
	prompt?: string;
	/** Named omp profile for the session; omitted means the default profile. */
	profile?: string;
	relayUrl: string;
	webUrl: string;
}

export interface StopFrame {
	t: "stop";
	id: string;
	reason?: string;
}

export interface PingFrame {
	t: "ping";
	ts: number;
}

/**
 * hub → agent command (protocol §2); answered with `cmd-result`. With `id` it
 * targets one session child; without it the daemon answers the machine-level
 * command itself (e.g. `list-dir` with its `path`).
 */
export interface CmdFrame {
	t: "cmd";
	/** Target session id; absent for machine-level commands. */
	id?: string;
	reqId: string;
	cmd: string;
	/** `list-dir` target directory; omitted lists the agent user's home. */
	path?: string;
	provider?: string;
	modelId?: string;
	/** `set-model` target role; omitted means `"default"`. */
	role?: string;
	/** `set-model`: persist a non-default role assignment (default true). */
	persist?: boolean;
	level?: string;
}

export type HubFrame = WelcomeFrame | StartFrame | StopFrame | PingFrame | CmdFrame;

export interface HelloFrame {
	t: "hello";
	name: string;
	machineId: string;
	version: string;
	/** The daemon's temp directory (`os.tmpdir()`), reported since protocol 0.3.0. */
	tmpdir: string;
}

export interface HeartbeatFrame {
	t: "hb";
	ts: number;
	sessions: Array<{ id: string; status: SessionStatus }>;
}

export interface SessionReadyFrame {
	t: "session-ready";
	id: string;
	sessionFile: string;
	pid: number;
	links: SessionLinks;
}

export interface SessionErrorFrame {
	t: "session-error";
	id: string;
	error: string;
}

export interface SessionExitFrame {
	t: "session-exit";
	id: string;
	code: number | null;
	reason: string;
}

export interface PongFrame {
	t: "pong";
	ts: number;
}

/** agent → hub answer to one `cmd` (protocol §2). */
export interface CmdResultFrame {
	t: "cmd-result";
	reqId: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

/** Frames the daemon sends outside `hello`/`hb`/`pong`. */
export type AgentFrame = SessionReadyFrame | SessionErrorFrame | SessionExitFrame | CmdResultFrame;

/** Every frame on the agent → hub wire. */
export type OutboundFrame = HelloFrame | HeartbeatFrame | PongFrame | AgentFrame;

export interface HubClientOptions {
	/** Hub base URL, `ws://`, `wss://`, `http://`, or `https://` (trailing slash optional). */
	url: string;
	token: string;
	name: string;
	machineId: string;
	sessions: () => Array<{ id: string; status: SessionStatus }>;
	onStart(frame: StartFrame): void;
	onStop(frame: StopFrame): void;
	onCmd(frame: CmdFrame): void;
	onWelcome?: (frame: WelcomeFrame) => void;
	log: Logger;
	heartbeatMs?: number;
}

function agentSocketUrl(hubUrl: string, token: string): string {
	let base = hubUrl.trim().replace(/\/+$/, "");
	if (base.startsWith("http://")) base = `ws://${base.slice("http://".length)}`;
	else if (base.startsWith("https://")) base = `wss://${base.slice("https://".length)}`;
	return `${base}/agent?token=${encodeURIComponent(token)}`;
}

/** 1 s, 2 s, 4 s … capped at 30 s, with ±25 % jitter so restarts don't stampede. */
function backoffDelay(attempt: number): number {
	const base = MIN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
	const jittered = base * (1 + 0.25 * (Math.random() * 2 - 1));
	return Math.min(Math.max(Math.round(jittered), MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}

export class HubClient {
	#options: HubClientOptions;
	#log: Logger;
	#socket: WebSocket | null = null;
	#closed = true;
	#connected = false;
	#attempt = 0;
	#reconnectTimer?: Timer;
	#heartbeatTimer?: Timer;
	#pending: AgentFrame[] = [];

	constructor(options: HubClientOptions) {
		this.#options = options;
		this.#log = options.log;
	}

	get connected(): boolean {
		return this.#connected;
	}

	/** Open the socket and keep it open until {@link close}. */
	start(): void {
		if (!this.#closed) return;
		this.#closed = false;
		this.#connect();
	}

	/** Stop reconnecting and close the socket. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearReconnect();
		this.#clearHeartbeat();
		this.#pending = [];
		const socket = this.#socket;
		this.#socket = null;
		this.#connected = false;
		if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
			try {
				socket.close(1000, "agent shutdown");
			} catch (err) {
				this.#log.debug(`socket close failed: ${errorMessage(err)}`);
			}
		}
		this.#log.info("hub connection closed");
	}

	/** Send a frame; queued (bounded) while the socket is down. */
	send(frame: AgentFrame): void {
		// `id` names the target session; machine-level frames (e.g. cmd-result
		// for `list-dir`) carry none.
		const target = "id" in frame ? frame.id : "machine";
		if (this.#sendNow(frame)) return;
		if (this.#closed) {
			this.#log.warn(`dropping ${frame.t} frame for ${frame.t === "cmd-result" ? frame.reqId : frame.id}: hub connection closed`);
			return;
		}
		if (this.#pending.length >= MAX_QUEUED_FRAMES) {
			const dropped = this.#pending.shift();
			this.#log.warn(`hub frame queue full; dropped ${dropped?.t ?? "frame"} for ${dropped?.t === "cmd-result" ? dropped.reqId : dropped?.id ?? "?"}`);
		}
		this.#pending.push(frame);
	}

	#sendNow(frame: OutboundFrame): boolean {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(JSON.stringify(frame));
			return true;
		} catch (err) {
			this.#log.warn(`hub send failed (${frame.t}): ${errorMessage(err)}`);
			return false;
		}
	}

	#connect(): void {
		if (this.#closed) return;
		const url = agentSocketUrl(this.#options.url, this.#options.token);
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (err) {
			this.#log.error(`failed to open hub socket: ${errorMessage(err)}`);
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;

		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.#attempt = 0;
			this.#connected = true;
			this.#log.info(`connected to hub ${this.#options.url}`);
			this.#sendNow({
				t: "hello",
				name: this.#options.name,
				machineId: this.#options.machineId,
				version: AGENT_VERSION,
				tmpdir: tmpdir(),
			});
			this.#startHeartbeat();
			const queued = this.#pending;
			this.#pending = [];
			for (const frame of queued) this.send(frame);
		};

		socket.onmessage = event => {
			if (this.#socket !== socket) return;
			this.#handleFrame(event.data as string | Uint8Array | ArrayBuffer);
		};

		socket.onerror = () => {
			// The close event that follows carries the code/reason; nothing to do here.
		};

		socket.onclose = event => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.#connected = false;
			this.#clearHeartbeat();
			if (this.#closed) return;
			if (event.code === FATAL_CLOSE_CODE) {
				this.#log.error(
					`hub closed the agent channel (${event.code}${event.reason ? `: ${event.reason}` : ""}); not reconnecting`,
				);
				this.#closed = true;
				return;
			}
			this.#log.warn(`hub connection lost (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`);
			this.#scheduleReconnect();
		};
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#reconnectTimer) return;
		this.#attempt += 1;
		const delay = backoffDelay(this.#attempt);
		this.#log.warn(`reconnecting to hub in ${Math.round(delay / 100) / 10}s (attempt ${this.#attempt})`);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#connect();
		}, delay);
	}

	#startHeartbeat(): void {
		this.#clearHeartbeat();
		const interval = this.#options.heartbeatMs ?? HEARTBEAT_MS;
		this.#heartbeatTimer = setInterval(() => {
			this.#sendNow({ t: "hb", ts: Date.now(), sessions: this.#options.sessions() });
		}, interval);
	}

	#clearHeartbeat(): void {
		if (!this.#heartbeatTimer) return;
		clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
	}

	#clearReconnect(): void {
		if (!this.#reconnectTimer) return;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
	}

	#handleFrame(data: string | Uint8Array | ArrayBuffer): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
		} catch {
			this.#log.warn("ignoring non-JSON frame from hub");
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			this.#log.warn("ignoring non-object frame from hub");
			return;
		}
		const frame = parsed as HubFrame;

		switch (frame.t) {
			case "welcome":
				this.#log.info(`hub welcome: relay=${frame.relayUrl} web=${frame.webUrl}`);
				this.#options.onWelcome?.(frame);
				return;
			case "start":
				this.#dispatch(() => this.#options.onStart(frame));
				return;
			case "stop":
				this.#dispatch(() => this.#options.onStop(frame));
				return;
			case "cmd":
				this.#dispatch(() => this.#options.onCmd(frame));
				return;
			case "ping":
				this.#sendNow({ t: "pong", ts: frame.ts });
				return;
			default:
				this.#log.debug(`ignoring unknown frame from hub: ${String((frame as { t?: string }).t)}`);
		}
	}

	#dispatch(handler: () => void): void {
		try {
			handler();
		} catch (err) {
			this.#log.error(`hub frame handler failed: ${errorMessage(err)}`);
		}
	}
}
