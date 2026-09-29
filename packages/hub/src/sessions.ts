/**
 * In-memory session registry (docs/protocol.md §3 `SessionRecord`).
 * Hub restart loses it; the agents re-register and report their sessions again.
 */
import path from "node:path";

export type SessionStatus = "starting" | "live" | "exited" | "failed";

export interface SessionLinks {
	full: string;
	view: string;
	web: string;
	webView: string;
}

/** Guest-visible activity mirrored from `session-activity` frames (protocol §3). */
export interface SessionActivity {
	working: boolean;
	inputRequired: boolean;
	/** True while the child generates a handoff document; absent otherwise. */
	handoff?: boolean;
	/** Hub clock at the last changed sample; freshness bound for stale mirrors. */
	updatedAt: number;
}

export interface SessionRecord {
	id: string;
	machineId: string;
	machineName: string;
	cwd: string;
	name: string;
	/** Named omp profile the session runs under; absent means the default profile. */
	profile?: string;
	/** Fleet-operator session (protocol §4 fleet-req); set at start, never minted by the fleet itself. */
	superagent?: true;
	status: SessionStatus;
	startedAt: number;
	exitedAt?: number;
	exitReason?: string;
	error?: string;
	links?: SessionLinks;
	sessionFile?: string;
	pid?: number;
	/** Last known working/input state; absent until the first sample arrives. */
	activity?: SessionActivity;
}

export interface CreateSessionInput {
	machineId: string;
	machineName: string;
	cwd: string;
	name?: string;
	profile?: string;
	/** Marks the started session a fleet operator (protocol §2 `start.superagent`). */
	superagent?: true;
}

export interface SessionReadyInput {
	sessionFile?: string;
	pid?: number;
	links?: SessionLinks;
}

/** MVP pruning cap: beyond this, the oldest terminal records are dropped first. */
export const SESSION_CAP = 500;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `prefix` + 10 base36 characters from a CSPRNG. */
export function randomId(prefix: string): string {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	let id = prefix;
	for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
	return id;
}

export function isTerminalStatus(status: SessionStatus): boolean {
	return status === "exited" || status === "failed";
}

export class SessionStore {
	readonly #sessions = new Map<string, SessionRecord>();
	/** Insertion order, so "newest first" is exact even within the same millisecond. */
	readonly #order = new Map<string, number>();
	#sequence = 0;

	create(input: CreateSessionInput): SessionRecord {
		const record: SessionRecord = {
			id: randomId("s_"),
			machineId: input.machineId,
			machineName: input.machineName,
			cwd: input.cwd,
			name: input.name?.trim() || path.basename(input.cwd) || input.cwd,
			...(input.profile ? { profile: input.profile } : {}),
			...(input.superagent ? { superagent: true as const } : {}),
			status: "starting",
			startedAt: Date.now(),
		};
		this.#sessions.set(record.id, record);
		this.#order.set(record.id, this.#sequence++);
		this.prune();
		return record;
	}

	get(id: string): SessionRecord | undefined {
		return this.#sessions.get(id);
	}

	/** Rolls back a record whose `start` frame never reached the agent. */
	delete(id: string): boolean {
		this.#order.delete(id);
		return this.#sessions.delete(id);
	}

	/** All states, newest first. */
	list(): SessionRecord[] {
		return [...this.#sessions.values()].sort(
			(a, b) => b.startedAt - a.startedAt || (this.#order.get(b.id) ?? 0) - (this.#order.get(a.id) ?? 0),
		);
	}

	/**
	 * Replaces the contents with `records` (any order), preserving recency
	 * order. Used by the upgrade-restart restore and the hot-reload handover.
	 */
	adopt(records: readonly SessionRecord[]): void {
		this.#sessions.clear();
		this.#order.clear();
		this.#sequence = 0;
		for (const record of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
			this.#sessions.set(record.id, record);
			this.#order.set(record.id, this.#sequence++);
		}
	}

	/** `live` + `starting` sessions on a machine (`MachineRecord.sessionCount`). */
	countActiveFor(machineId: string): number {
		let count = 0;
		for (const record of this.#sessions.values()) {
			if (record.machineId === machineId && !isTerminalStatus(record.status)) count++;
		}
		return count;
	}

	/** `session-ready`: flips to `live` and attaches links. */
	markReady(id: string, ready: SessionReadyInput): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || isTerminalStatus(record.status)) return record;
		record.status = "live";
		if (ready.sessionFile !== undefined) record.sessionFile = ready.sessionFile;
		if (ready.pid !== undefined) record.pid = ready.pid;
		if (ready.links !== undefined) record.links = ready.links;
		return record;
	}

	/** `session-activity`: mirrors the child's last sample; unknown ids are ignored. */
	setActivity(id: string, activity: Omit<SessionActivity, "updatedAt">): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || isTerminalStatus(record.status)) return record;
		record.activity = { ...activity, updatedAt: Date.now() };
		return record;
	}

	/** `rename` success: the registry label follows the agent-side session name. */
	rename(id: string, name: string): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record) return record;
		const trimmed = name.trim();
		if (trimmed) record.name = trimmed;
		return record;
	}

	/** `session-error`: start failed before ready. */
	markFailed(id: string, error: string): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || isTerminalStatus(record.status)) return record;
		record.status = "failed";
		record.error = error;
		record.exitedAt = Date.now();
		record.activity = undefined;
		return record;
	}

	/** `session-exit`: idempotent; a terminal record keeps its first terminal state. */
	markExited(id: string, reason?: string): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || isTerminalStatus(record.status)) return record;
		record.status = "exited";
		record.exitedAt = Date.now();
		record.activity = undefined;
		if (reason) record.exitReason = reason;
		return record;
	}

	/**
	 * Daemon-restart recovery (protocol §2 `restart-daemon`): flips a terminal
	 * record back to `starting` so the hub can re-issue a `start` under the SAME
	 * id, keeping panel pages and links stable. Identity fields (cwd, name,
	 * profile, sessionFile, superagent) survive; volatile child state (links,
	 * pid, activity, exit fields) clears and refills from `session-ready`.
	 * `startedAt` deliberately stays: the reconcile watermark (`startedAt <
	 * connectedAt`) must keep treating the resumed record as pre-connection, so
	 * later heartbeats still retire it if the resumed child dies quietly.
	 */
	reissue(id: string): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || !record.sessionFile) return record;
		record.status = "starting";
		record.links = undefined;
		record.pid = undefined;
		record.activity = undefined;
		record.exitedAt = undefined;
		record.exitReason = undefined;
		record.error = undefined;
		return record;
	}

	/** Marks every non-terminal session of a machine exited; returns the affected ids. */
	exitSessionsFor(machineId: string, reason: string): string[] {
		const ids: string[] = [];
		for (const record of this.#sessions.values()) {
			if (record.machineId !== machineId || isTerminalStatus(record.status)) continue;
			record.status = "exited";
			record.exitedAt = Date.now();
			record.exitReason = reason;
			record.activity = undefined;
			ids.push(record.id);
		}
		return ids;
	}

	/** Drops oldest-terminal records until the cap is met; returns how many were dropped. */
	prune(cap: number = SESSION_CAP): number {
		if (this.#sessions.size <= cap) return 0;
		const terminal = [...this.#sessions.values()]
			.filter((record) => isTerminalStatus(record.status))
			.sort((a, b) => (a.exitedAt ?? a.startedAt) - (b.exitedAt ?? b.startedAt));
		let dropped = 0;
		for (const record of terminal) {
			if (this.#sessions.size <= cap) break;
			this.#sessions.delete(record.id);
			this.#order.delete(record.id);
			dropped++;
		}
		return dropped;
	}
}
