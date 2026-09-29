/**
 * Parent-side session registry: one child process per session (docs/protocol.md §4).
 *
 * Each child speaks JSONL on stdout and accepts `{t:"stop"}` on stdin.
 * Non-JSON stdout lines are treated as logs (they should not happen — the
 * child seals stdout); stderr is inherited.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { errorMessage, type Logger, type LogLevel } from "./log";
import { isCompiledAgent } from "./native-mode";
import { defaultProfilesRoot, normalizeProfileName, profileExists } from "./profiles";

/** docs/protocol.md §3 SessionStatus. */
export type SessionStatus = "starting" | "live" | "exited" | "failed";

/** docs/protocol.md §2 session links, minted by the child's CollabHost. */
export interface SessionLinks {
	full: string;
	view: string;
	web: string;
	webView: string;
}

/** Spawn config: hub `start` frame fields, passed verbatim as argv JSON. */
export interface SessionConfig {
	id: string;
	cwd: string;
	name?: string;
	prompt?: string;
	/** Named omp profile; validated against the machine before the child spawns. */
	profile?: string;
	/** Resume an existing omp session file instead of minting a new one. */
	sessionFile?: string;
	/** 0.8.0: fleet-operator session — the child registers fleet tools; its `fleet-req` frames are proxied. */
	superagent?: true;
	/** 0.9.0: callable-tool whitelist (protocol §2 `start.tools`); the child restricts the SDK session to it. */
	tools?: string[];
	/** 0.9.0: arm the one-shot prewalk hand-off at startup; `true` = `@smol`, a string = explicit pattern. */
	prewalk?: boolean | string;
	/** 0.9.0: start in plan mode with the hand-off target; `true` = `@smol`, a string = explicit pattern. */
	planYolo?: boolean | string;
	relayUrl: string;
	webUrl: string;
	agentDir?: string;
}

/** Child → parent `ready` frame payload. */
export interface SessionReadyPayload {
	sessionFile: string;
	pid: number;
	links: SessionLinks;
}

export interface SupervisorHandlers {
	onReady(id: string, payload: SessionReadyPayload): void;
	onError(id: string, error: string): void;
	onExit(id: string, code: number | null, reason: string): void;
	/**
	 * Child `activity` sample (protocol §4): guest-visible working/input state
	 * changed. Observational only — consumers that never mirror activity (tests,
	 * tooling) omit it.
	 */
	onActivity?(id: string, activity: SessionActivity): void;
	/** Worker lifecycle/input event; the worker id is always the child record's id. */
	onFleetEvent?(id: string, event: { eventId: string; kind: "input_required" | "input_resolved" | "turn_finished" | "operation_failed"; requestId?: string; leafId?: string; operationId?: string; error?: string }): void;
}

/** Guest-visible session state mirrored into the hub registry (protocol §3). */
export interface SessionActivity {
	/** The agent turn is streaming (includes tool execution). */
	working: boolean;
	/** A host-side dialog waits on a writable guest (`CollabHost.inputRequired`). */
	inputRequired: boolean;
	/** SDK session name (auto-titles included); absent/blank leaves the label untouched. */
	name?: string;
	/** True while the child generates a handoff document; absent otherwise. */
	handoff?: boolean;
}

/** Parent → child `cmd` payload (protocol §4); `reqId` correlates the reply.
 * Parameters beyond the routing fields pass through unvalidated — per-command
 * validation lives in the session host's executeCommand. */
export interface CommandRequest {
	reqId: string;
	cmd: string;
	[key: string]: unknown;
}

/** Normalized child `cmd-result` (protocol §4): exactly one of data/error. */
export type CommandResult = { ok: true; data: unknown } | { ok: false; error: string };

/** One in-flight command: which session owes the reply, and how to settle it. */
interface PendingCommand {
	sessionId: string;
	resolve(result: CommandResult): void;
	reject(error: Error): void;
}

export interface SupervisorOptions {
	/** Source/fixture session host entry point; defaults to `./session-host.ts` outside compiled mode. */
	hostEntry?: string;
	/** omp profiles root for existence checks; defaults to `~/$PI_CONFIG_DIR|.omp/profiles`. */
	profilesRoot?: string;
	/**
	 * 0.8.0 fleet proxy: answers a superagent child's `fleet-req` frames against
	 * the hub API. Non-superagent children never reach it.
	 */
	fleet?: (req: { ownerId: string; reqId: string; method: string; path: string; body?: unknown }) => Promise<
		{ ok: true; status: number; body?: unknown } | { ok: false; error: string }
	>;
}

/** Child must exit within 10 s of stop; escalate to SIGKILL after that (protocol §4). */
const STOP_GRACE_MS = 10_000;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Every session child: stdin/stdout piped for JSONL, stderr inherited. */
type SessionChild = Bun.Subprocess<"pipe", "pipe", "inherit">;

interface ChildRecord {
	id: string;
	config: SessionConfig;
	/** Resolved `config.sessionFile` when resuming; guards double-open. */
	sessionFile?: string;
	child: SessionChild;
	status: SessionStatus;
	error?: string;
	stopReason?: string;
	killTimer?: Timer;
}

/** Select a separate session process, never a virtual bunfs entry in compiled mode. */
export function sessionHostCommand(
	config: SessionConfig,
	options: { execPath: string; compiled: boolean; hostEntry?: string },
): string[] {
	const entry = options.hostEntry ?? (options.compiled ? undefined : new URL("./session-host.ts", import.meta.url).pathname);
	const payload = JSON.stringify(config);
	return entry
		? [options.execPath, entry, "--config", payload]
		: [path.join(path.dirname(options.execPath), "omp-hub-agent-session"), "--config", payload];
}

export class Supervisor {
	#children = new Map<string, ChildRecord>();
	#handlers: SupervisorHandlers;
	#log: Logger;
	/** Explicit source/fixture host override, if any. */
	#hostEntry: string | undefined;
	/** omp profiles root backing profile existence checks. */
	#profilesRoot: string;
	/** Fleet proxy handler for superagent children (protocol 0.8.0). */
	#fleet: SupervisorOptions["fleet"];
	/** In-flight `cmd` requests keyed by reqId (protocol §4). */
	#pending = new Map<string, PendingCommand>();

	constructor(handlers: SupervisorHandlers, log: Logger, options: SupervisorOptions = {}) {
		this.#handlers = handlers;
		this.#log = log;
		this.#hostEntry = options.hostEntry;
		this.#profilesRoot = options.profilesRoot ?? defaultProfilesRoot();
		this.#fleet = options.fleet;
	}

	/** Sessions occupying a slot (starting or live). */
	get liveCount(): number {
		let count = 0;
		for (const record of this.#children.values()) {
			if (record.status === "starting" || record.status === "live") count++;
		}
		return count;
	}

	/** Heartbeat payload: every tracked session with its current status. */
	status(): Array<{ id: string; status: SessionStatus }> {
		return [...this.#children.values()].map(record => ({ id: record.id, status: record.status }));
	}

	/**
	 * Send one `cmd` frame to `id`'s child and resolve with its `cmd-result`
	 * (protocol §4). Unknown sessions resolve `{ok:false,"unknown session"}`
	 * (the hub's 404 case); duplicate reqIds, write failures, and child exits
	 * before an answer reject.
	 */
	async cmd(id: string, request: CommandRequest): Promise<CommandResult> {
		const record = this.#children.get(id);
		if (!record) return { ok: false, error: "unknown session" };
		if (this.#pending.has(request.reqId)) throw new Error(`duplicate reqId ${request.reqId}`);

		// The pending entry exists before the write so an instant answer (or an
		// instant child death) can never race past its own correlation.
		const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
		this.#pending.set(request.reqId, { sessionId: id, resolve, reject });
		try {
			record.child.stdin.write(`${JSON.stringify({ t: "cmd", ...request })}\n`);
			// `flush()` is synchronous for pipes but may hand back a promise.
			void Promise.resolve(record.child.stdin.flush()).catch(err => {
				this.#rejectCommand(request.reqId, new Error(`failed to send cmd to session ${id}: ${errorMessage(err)}`));
			});
		} catch (err) {
			this.#rejectCommand(request.reqId, new Error(`failed to send cmd to session ${id}: ${errorMessage(err)}`));
		}
		return await promise;
	}

	/** Push an inbox event to the actual owner child, not an id from child IPC. */
	notifyFleet(id: string, event: unknown): boolean {
		const record = this.#children.get(id);
		if (!record || record.config.superagent !== true || record.status !== "live") return false;
		try {
			record.child.stdin.write(`${JSON.stringify({ t: "fleet-notification", event })}\n`);
			void Promise.resolve(record.child.stdin.flush()).catch(err => this.#log.warn(`fleet notification to ${id} failed: ${errorMessage(err)}`));
			return true;
		} catch (err) {
			this.#log.warn(`fleet notification to ${id} failed: ${errorMessage(err)}`);
			return false;
		}
	}

	/**
	 * Spawn a child for `config`. Start failures (bad cwd, spawn error) are reported
	 * through `onError` — the hub maps them to `session-error`.
	 */
	async spawn(config: SessionConfig): Promise<void> {
		if (this.#children.has(config.id)) {
			const message = `session ${config.id} is already running`;
			this.#log.error(message);
			this.#handlers.onError(config.id, message);
			return;
		}

		const cwd = await stat(config.cwd).catch(() => null);
		if (!cwd?.isDirectory()) {
			const message = `cwd is not an existing directory: ${config.cwd}`;
			this.#log.error(`session ${config.id}: ${message}`);
			this.#handlers.onError(config.id, message);
			return;
		}

		let profile: string | undefined;
		try {
			profile = normalizeProfileName(config.profile);
		} catch (err) {
			const message = errorMessage(err);
			this.#log.error(`session ${config.id}: ${message}`);
			this.#handlers.onError(config.id, message);
			return;
		}
		// omp would create an unknown profile on first CLI use; a hub start with
		// `autoApprove` and the profile's credentials must not mint one on a typo.
		if (profile && !(await profileExists(profile, this.#profilesRoot))) {
			const message = `profile "${profile}" not found on this machine`;
			this.#log.error(`session ${config.id}: ${message}`);
			this.#handlers.onError(config.id, message);
			return;
		}

		// Session files carry no cross-process lock (append-only JSONL): two live
		// children on one file would interleave appends and corrupt history. The
		// resolved path — not the raw string — keeps aliased spellings from
		// slipping past the guard.
		const sessionFile = config.sessionFile ? path.resolve(config.sessionFile) : undefined;
		if (sessionFile) {
			for (const record of this.#children.values()) {
				if (record.sessionFile !== sessionFile) continue;
				if (record.status !== "starting" && record.status !== "live") continue;
				const message = `session file already in use by session ${record.id}: ${sessionFile}`;
				this.#log.error(`session ${config.id}: ${message}`);
				this.#handlers.onError(config.id, message);
				return;
			}
		}

		const argv = sessionHostCommand(config, {
			execPath: process.execPath,
			compiled: isCompiledAgent,
			hostEntry: this.#hostEntry,
		});
		let child: SessionChild;
		try {
			// The web selection fully determines the child's omp profile: ambient
			// daemon-level OMP_PROFILE/PI_PROFILE never leaks into a session the hub
			// started as "default", and a chosen profile overrides both. The child
			// resolves these before any SDK import (pi-utils/dirs, module load).
			const env: Record<string, string | undefined> = { ...process.env };
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;
			if (profile) {
				env.OMP_PROFILE = profile;
				env.PI_PROFILE = profile;
			}
			child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: config.cwd, env });
		} catch (err) {
			const message = `failed to spawn session host: ${errorMessage(err)}`;
			this.#log.error(`session ${config.id}: ${message}`);
			this.#handlers.onError(config.id, message);
			return;
		}

		const record: ChildRecord = { id: config.id, config, sessionFile, child, status: "starting" };
		this.#children.set(config.id, record);
		this.#log.info(`spawned session ${config.id} (pid ${child.pid}) in ${config.cwd}`);
		void this.#readStdout(record);
		void this.#watchExit(record);
	}

	/** Ask one child to stop; SIGKILL after the 10 s grace window. */
	async stop(id: string, reason = "stop"): Promise<void> {
		const record = this.#children.get(id);
		if (!record) {
			this.#log.warn(`stop requested for unknown session ${id}`);
			return;
		}
		if (record.stopReason === undefined) record.stopReason = reason;
		this.#log.info(`stopping session ${id} (${reason})`);

		try {
			record.child.stdin.write(`${JSON.stringify({ t: "stop", reason })}\n`);
			await record.child.stdin.flush();
		} catch (err) {
			this.#log.warn(`stdin stop failed for ${id} (${errorMessage(err)}); sending SIGTERM`);
			try {
				record.child.kill("SIGTERM");
			} catch (killError) {
				this.#log.debug(`SIGTERM failed for ${id}: ${errorMessage(killError)}`);
			}
		}

		record.killTimer ??= setTimeout(() => {
			if (record.child.exitCode === null) {
				this.#log.warn(`session ${id} did not exit within ${STOP_GRACE_MS / 1000}s; sending SIGKILL`);
				try {
					record.child.kill(9);
				} catch (err) {
					this.#log.debug(`SIGKILL failed for ${id}: ${errorMessage(err)}`);
				}
			}
		}, STOP_GRACE_MS);
	}

	/** Stop every child and wait (bounded) for their exits. */
	async stopAll(reason = "shutdown"): Promise<void> {
		const records = [...this.#children.values()];
		if (records.length === 0) return;
		this.#log.info(`stopping ${records.length} session(s) (${reason})`);
		await Promise.all(records.map(record => this.stop(record.id, reason)));
		const exited = records.map(record => record.child.exited.catch(() => null));
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(timeout.resolve, STOP_GRACE_MS + 2_000);
		await Promise.race([Promise.all(exited).then(() => undefined), timeout.promise]);
		clearTimeout(timer);
	}

	async #readStdout(record: ChildRecord): Promise<void> {
		const reader = record.child.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) this.#handleLine(record, line);
					newline = buffer.indexOf("\n");
				}
			}
		} catch (err) {
			this.#log.warn(`stdout read failed for ${record.id}: ${errorMessage(err)}`);
		}
		const tail = buffer.trim();
		if (tail) this.#handleLine(record, tail);
	}

	#handleLine(record: ChildRecord, line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.#log.warn(`child ${record.id}: non-JSON stdout line: ${line}`);
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			this.#log.warn(`child ${record.id}: non-object stdout frame`);
			return;
		}
		const frame = parsed as Record<string, unknown>;

		switch (frame.t) {
			case "ready": {
				const links = (frame.links ?? {}) as Partial<SessionLinks>;
				record.status = "live";
				this.#handlers.onReady(record.id, {
					sessionFile: typeof frame.sessionFile === "string" ? frame.sessionFile : "",
					pid: typeof frame.pid === "number" ? frame.pid : (record.child.pid ?? -1),
					links: {
						full: typeof links.full === "string" ? links.full : "",
						view: typeof links.view === "string" ? links.view : "",
						web: typeof links.web === "string" ? links.web : "",
						webView: typeof links.webView === "string" ? links.webView : "",
					},
				});
				return;
			}
			case "error": {
				const message = typeof frame.message === "string" ? frame.message : "session host reported an error";
				record.status = "failed";
				record.error = message;
				this.#handlers.onError(record.id, message);
				return;
			}
			case "log": {
				const level = LOG_LEVELS.find(name => name === frame.level) ?? "info";
				this.#log[level](`child ${record.id}: ${typeof frame.message === "string" ? frame.message : ""}`);
				return;
			}
			case "activity": {
				// Boolean coercion: a malformed sample is dropped, never guessed.
				if (typeof frame.working !== "boolean" || typeof frame.inputRequired !== "boolean") {
					this.#log.warn(`child ${record.id}: malformed activity frame`);
					return;
				}
				this.#handlers.onActivity?.(record.id, {
					working: frame.working,
					inputRequired: frame.inputRequired,
					// Optional §4 `name`; older children never send it, blank is noise.
					...(typeof frame.name === "string" && frame.name.trim() !== "" ? { name: frame.name } : {}),
					// Optional §4 `handoff` bit; present only when the child says true.
					...(frame.handoff === true ? { handoff: true } : {}),
				});
				return;
			}
			case "cmd-result": {
				const reqId = typeof frame.reqId === "string" ? frame.reqId : "";
				const pending = this.#pending.get(reqId);
				if (!pending) {
					this.#log.warn(`child ${record.id}: cmd-result for unknown reqId ${reqId}`);
					return;
				}
				if (pending.sessionId !== record.id) {
					this.#log.warn(`child ${record.id}: cmd-result for ${pending.sessionId}'s reqId ${reqId}`);
					return;
				}
				this.#pending.delete(reqId);
				if (frame.ok === true) pending.resolve({ ok: true, data: frame.data });
				else {
					const error = typeof frame.error === "string" ? frame.error : "session command failed";
					pending.resolve({ ok: false, error });
				}
				return;
			}
			case "fleet-event": {
				const kind = frame.kind;
				if (kind !== "input_required" && kind !== "input_resolved" && kind !== "turn_finished" && kind !== "operation_failed") return;
				if (typeof frame.eventId !== "string" || !frame.eventId) return;
				this.#handlers.onFleetEvent?.(record.id, {
					eventId: frame.eventId,
					kind,
					...(typeof frame.requestId === "string" ? { requestId: frame.requestId } : {}),
					...(typeof frame.leafId === "string" ? { leafId: frame.leafId } : {}),
					...(typeof frame.operationId === "string" ? { operationId: frame.operationId } : {}),
					...(typeof frame.error === "string" ? { error: frame.error.slice(0, 2000) } : {}),
				});
				return;
			}
			case "fleet-req": {
				// Answered exactly once (protocol 0.8.0 §4): refusal, handler
				// result, or handler throw — never silence.
				const reqId = typeof frame.reqId === "string" ? frame.reqId : "";
				const reply = (res: Record<string, unknown>): void => {
					try {
						record.child.stdin.write(`${JSON.stringify({ t: "fleet-res", reqId, ...res })}\n`);
						void Promise.resolve(record.child.stdin.flush()).catch(() => {});
					} catch {
						// Child is gone; there is nobody left to answer.
					}
				};
				if (record.config.superagent !== true) {
					reply({ ok: false, error: "fleet: not a superagent session" });
					return;
				}
				const request = {
					ownerId: record.id,
					reqId,
					method: typeof frame.method === "string" ? frame.method : "",
					path: typeof frame.path === "string" ? frame.path : "",
					...(frame.body === undefined ? {} : { body: frame.body }),
				};
				void (async () => {
					try {
						const result =
							(await this.#fleet?.(request)) ?? { ok: false as const, error: "fleet: no proxy configured" };
						reply(result);
					} catch (err) {
						reply({ ok: false, error: errorMessage(err) });
					}
				})();
				return;
			}
			default:
				this.#log.debug(`child ${record.id}: unknown frame type ${String(frame.t)}`);
		}
	}

	async #watchExit(record: ChildRecord): Promise<void> {
		const code = await record.child.exited;
		if (record.killTimer) clearTimeout(record.killTimer);
		this.#children.delete(record.id);
		const reason =
			record.stopReason ?? record.error ?? (code === 0 ? "exit" : `exited with code ${String(code)}`);
		// Callers must not hang on a child that will never answer (§2: the hub has
		// its own 15 s timeout, but an exited session answers nothing at all).
		this.#rejectSessionCommands(record.id, new Error(`session ${record.id} exited: ${reason}`));
		this.#log.info(`session ${record.id} exited (code ${String(code)}): ${reason}`);
		this.#handlers.onExit(record.id, code, reason);
	}

	/** Reject and drop one pending command; no-op once the child answered it. */
	#rejectCommand(reqId: string, error: Error): void {
		const pending = this.#pending.get(reqId);
		if (!pending) return;
		this.#pending.delete(reqId);
		pending.reject(error);
	}

	/** Reject every command a dying child still owes its callers. */
	#rejectSessionCommands(sessionId: string, error: Error): void {
		for (const [reqId, pending] of this.#pending) {
			if (pending.sessionId !== sessionId) continue;
			this.#pending.delete(reqId);
			pending.reject(error);
		}
	}
}
