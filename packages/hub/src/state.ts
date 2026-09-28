/**
 * Hub state persistence (docs/protocol.md §3): the in-memory registry —
 * machines and session records — survives a hub restart through a small JSON
 * snapshot, so a version upgrade does not orphan live sessions. Live rooms are
 * not persisted: the session hosts' relay sockets retry and re-create their
 * rooms (same roomId + key), and guests rejoin; only hub-side records need to
 * cross the process boundary.
 *
 * The file is write-through (polled, coalesced), atomic (tmp + rename), and
 * carries live links/keys — treat it like the registry itself: sensitive.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./log";
import type { MachineRecord } from "./agents";
import type { SessionRecord } from "./sessions";

const SNAPSHOT_VERSION = 1;

export interface StateSnapshot {
	version: typeof SNAPSHOT_VERSION;
	savedAt: number;
	/** Restored with `connected: false`; machines re-register via `hello`. */
	readonly machines: readonly MachineRecord[];
	readonly sessions: readonly SessionRecord[];
}

export function serializeState(machines: readonly MachineRecord[], sessions: readonly SessionRecord[]): string {
	const snapshot: StateSnapshot = {
		version: SNAPSHOT_VERSION,
		savedAt: Date.now(),
		// `connected` is a property of the socket, not of the machine: a fresh
		// hub process has no agent sockets until they reconnect.
		machines: machines.map((machine) => ({ ...machine, connected: false })),
		sessions: sessions,
	};
	return JSON.stringify(snapshot);
}

/**
 * Tolerant parse: anything version-mismatched, truncated, or malformed reads
 * as "no state" — a bad file must never keep the hub from booting.
 */
export function parseStateSnapshot(raw: string): StateSnapshot | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const candidate = parsed as { version?: unknown; savedAt?: unknown; machines?: unknown; sessions?: unknown };
		if (candidate.version !== SNAPSHOT_VERSION) return null;
		if (typeof candidate.savedAt !== "number") return null;
		if (!Array.isArray(candidate.machines) || !Array.isArray(candidate.sessions)) return null;
		return candidate as unknown as StateSnapshot;
	} catch {
		return null;
	}
}

/** Reads the snapshot file; null when absent or unusable (boot proceeds empty). */
export function loadStateSnapshot(file: string): StateSnapshot | null {
	let raw: string;
	try {
		// Sync on purpose: buildHub must stay synchronous — the hot-reload swap
		// relies on the whole build/adopt/swap sequence being one event-loop block.
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const snapshot = parseStateSnapshot(raw);
	if (snapshot === null) log.warn(`state file ${file} is unusable — starting with an empty registry`);
	return snapshot;
}

/**
 * Write-through persistence: `sync` writes only when the serialized registry
 * changed (compare-then-write), coalesces while a write is in flight, and
 * replaces atomically so a crash mid-write cannot corrupt the previous state.
 */
export class StatePersistence {
	#lastWritten: string | null = null;
	#writing = false;
	#pending: string | null = null;

	constructor(readonly file: string) {}

	async sync(machines: readonly MachineRecord[], sessions: readonly SessionRecord[]): Promise<void> {
		const content = serializeState(machines, sessions);
		if (content === this.#lastWritten) return;
		if (this.#writing) {
			this.#pending = content;
			return;
		}
		await this.#write(content);
	}

	async #write(content: string): Promise<void> {
		this.#writing = true;
		try {
			const tmp = `${this.file}.tmp-${process.pid}`;
			await mkdir(path.dirname(this.file), { recursive: true });
			await writeFile(tmp, content);
			await rename(tmp, this.file);
			this.#lastWritten = content;
		} catch (err) {
			// Persistence is best-effort: a failed write must not take the hub
			// down. The next successful poll retries.
			log.warn(`state write failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.#writing = false;
		}
		if (this.#pending !== null) {
			const pending = this.#pending;
			this.#pending = null;
			if (pending !== this.#lastWritten) await this.#write(pending);
		}
	}
}
