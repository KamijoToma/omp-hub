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

export interface CreateSessionInput {
	machineId: string;
	machineName: string;
	cwd: string;
	name?: string;
}

export interface SessionReadyInput {
	sessionFile?: string;
	pid?: number;
	links?: SessionLinks;
}

/** MVP pruning cap: beyond this, the oldest terminal records are dropped first. */
export const SESSION_CAP = 500;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `s_` + 10 base36 characters from a CSPRNG. */
export function newSessionId(): string {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	let id = "s_";
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
			id: newSessionId(),
			machineId: input.machineId,
			machineName: input.machineName,
			cwd: input.cwd,
			name: input.name?.trim() || path.basename(input.cwd) || input.cwd,
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

	/** `session-error`: start failed before ready. */
	markFailed(id: string, error: string): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || isTerminalStatus(record.status)) return record;
		record.status = "failed";
		record.error = error;
		record.exitedAt = Date.now();
		return record;
	}

	/** `session-exit`: idempotent; a terminal record keeps its first terminal state. */
	markExited(id: string, reason?: string): SessionRecord | undefined {
		const record = this.#sessions.get(id);
		if (!record || isTerminalStatus(record.status)) return record;
		record.status = "exited";
		record.exitedAt = Date.now();
		if (reason) record.exitReason = reason;
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
