/**
 * Shared hub session registry: one poll of `/api/sessions` behind a
 * `useSyncExternalStore` store, consumed by the session rail, the session
 * page's record gate, and the alerts watcher (previously three independent
 * pollers). Keeps the last good listing on transient errors (stale-while-
 * error), caches per-id detail records (`getSession`) so switching to a known
 * session needs no HTTP round trip before the surface mounts, and only polls
 * while at least one subscriber is attached.
 */
import { useSyncExternalStore } from "react";
import { errorText, getSession, getSessions, type SessionRecord } from "./api";

/** Registry poll cadence; matches the old rail/home listing poll. */
const DEFAULT_POLL_MS = 2000;

export interface SessionsSnapshot {
	/** Monotonic bump per store mutation; snapshot object is stable per version. */
	readonly version: number;
	/** Last good listing; retained (stale) across poll errors. */
	readonly sessions: readonly SessionRecord[] | null;
	/** Last listing error, cleared on the next good poll. */
	readonly error: string | null;
	/** id → known record (list rows overlaid with per-id detail fetches). */
	readonly records: ReadonlyMap<string, SessionRecord>;
	/** Per-id detail errors (`refreshSession` failures); cleared when the id resolves. */
	readonly detailErrors: ReadonlyMap<string, string>;
}

export interface SessionsStoreOptions {
	/** Test seams; default to the real hub API calls. */
	fetchSessions?: typeof getSessions;
	fetchSession?: typeof getSession;
	pollMs?: number;
}

export interface SessionsStore {
	subscribe(listener: () => void): () => void;
	getSnapshot(): SessionsSnapshot;
	/** Known record for an id, if any. */
	record(id: string): SessionRecord | null;
	/** Last `refreshSession` error for an id, if any. */
	detailError(id: string): string | null;
	/** Fetch one session's detail into the cache; resolves the record or null. */
	refreshSession(id: string): Promise<SessionRecord | null>;
	/** Force an immediate listing poll (rename feedback). */
	refresh(): void;
}

export function createSessionsStore(opts: SessionsStoreOptions = {}): SessionsStore {
	const fetchSessions = opts.fetchSessions ?? getSessions;
	const fetchSession = opts.fetchSession ?? getSession;
	const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

	let version = 0;
	let sessions: readonly SessionRecord[] | null = null;
	let error: string | null = null;
	const records = new Map<string, SessionRecord>();
	const detailErrors = new Map<string, string>();
	let snapshot: SessionsSnapshot = {
		version,
		sessions: null,
		error: null,
		records: new Map(),
		detailErrors: new Map(),
	};

	const listeners = new Set<() => void>();
	let timer: Timer | null = null;
	let inFlight = false;

	function emit(): void {
		version += 1;
		snapshot = {
			version,
			sessions,
			error,
			records: new Map(records),
			detailErrors: new Map(detailErrors),
		};
		for (const listener of listeners) listener();
	}

	async function poll(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const next = await fetchSessions();
			sessions = next;
			error = null;
			for (const record of next) records.set(record.id, record);
		} catch (err) {
			// Registry hiccup: keep showing the stale listing.
			error = errorText(err);
		}
		inFlight = false;
		emit();
	}

	function ensureStarted(): void {
		if (timer !== null || listeners.size === 0) return;
		void poll();
		timer = setInterval(() => void poll(), pollMs);
	}

	function maybeStopped(): void {
		if (listeners.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			ensureStarted();
			return () => {
				listeners.delete(listener);
				maybeStopped();
			};
		},
		getSnapshot() {
			return snapshot;
		},
		record(id) {
			return records.get(id) ?? null;
		},
		detailError(id) {
			return detailErrors.get(id) ?? null;
		},
		refreshSession: async id => {
			try {
				const record = await fetchSession(id);
				records.set(id, record);
				detailErrors.delete(id);
				emit();
				return record;
			} catch (err) {
				detailErrors.set(id, errorText(err));
				emit();
				return null;
			}
		},
		refresh() {
			void poll();
		},
	};
}

/** Process-wide store; session-page consumers share this instance. */
export const sessionsStore = createSessionsStore();

function useSessionsSnapshot(): SessionsSnapshot {
	return useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot, sessionsStore.getSnapshot);
}

/** The listing plus its poll error (rail, alerts watcher). */
export function useSessions(): { sessions: readonly SessionRecord[] | null; error: string | null } {
	const snapshot = useSessionsSnapshot();
	return { sessions: snapshot.sessions, error: snapshot.error };
}

/** Known record for one session: per-id detail fetches overlay the listing. */
export function useSessionRecord(id: string): { record: SessionRecord | null; error: string | null } {
	const snapshot = useSessionsSnapshot();
	return { record: snapshot.records.get(id) ?? null, error: snapshot.detailErrors.get(id) ?? null };
}
