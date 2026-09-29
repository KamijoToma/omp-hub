/**
 * Local "task completed" markers for the session rail (protocol §3
 * `SessionRecord.activity`): a live session whose mirrored `working` flag
 * drops without `inputRequired` has finished its task. The marker is
 * browser-local state (localStorage-backed) and clears when the user opens
 * the session, so the rail keeps pointing at completed sessions that have
 * not been visited yet — everything else reads as plain idle.
 */
import { useMemo, useEffect, useRef, useSyncExternalStore } from "react";
import type { SessionRecord } from "./api";
import { useSessions } from "./sessions-store";

/** localStorage key holding the JSON array of completed-but-unvisited ids. */
const COMPLETED_KEY = "omp-hub.rail.completed";

function loadCompleted(): readonly string[] {
	try {
		const raw = globalThis.localStorage?.getItem(COMPLETED_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string").sort();
	} catch {
		return [];
	}
}

function persistCompleted(ids: readonly string[]): void {
	try {
		if (ids.length === 0) globalThis.localStorage?.removeItem(COMPLETED_KEY);
		else globalThis.localStorage?.setItem(COMPLETED_KEY, JSON.stringify(ids));
	} catch {
		// persistence is best-effort; the in-memory set still serves this page
	}
}

let completedIds: readonly string[] = loadCompleted();
const listeners = new Set<() => void>();

function getCompletedSnapshot(): readonly string[] {
	return completedIds;
}

function subscribeCompleted(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Replaces the set (sorted, deduped); emits only on a real content change. */
function replaceCompleted(next: readonly string[]): void {
	const sorted = [...new Set(next)].sort();
	if (sorted.length === completedIds.length && sorted.every((id, i) => id === completedIds[i])) return;
	completedIds = sorted;
	persistCompleted(completedIds);
	for (const listener of listeners) listener();
}

/** Flags sessions as completed; ids already marked (or unknown) are no-ops. */
export function markCompletedSessions(ids: readonly string[]): void {
	if (ids.length === 0) return;
	replaceCompleted([...completedIds, ...ids]);
}

/** The user opened the session: its completed marker becomes plain idle. */
export function clearCompletedSession(id: string): void {
	if (!completedIds.includes(id)) return;
	replaceCompleted(completedIds.filter(marked => marked !== id));
}

/**
 * Drops markers that no longer point at a live session (exited, pruned, or
 * from a restarted hub), keeping the persisted set bounded.
 */
export function pruneCompletedSessions(liveIds: readonly string[]): void {
	const keep = new Set(liveIds);
	replaceCompleted(completedIds.filter(id => keep.has(id)));
}

/**
 * Working→stopped edges count only when the session remains reachable and live,
 * has stopped working, and does not need input. A daemon disconnect is not a
 * completed task; brand-new records are a baseline, not an edge.
 */
export function diffCompletedSessions(prev: readonly SessionRecord[], next: readonly SessionRecord[]): string[] {
	const before = new Map(prev.map(record => [record.id, record]));
	const done: string[] = [];
	for (const record of next) {
		const was = before.get(record.id);
		if (was === undefined) continue;
		if (was.activity?.working !== true) continue;
		if (record.status !== "live") continue;
		if (record.unreachable) continue; // a dropped daemon link is not a completed task
		if (record.activity?.working === true) continue;
		if (record.activity?.inputRequired === true) continue;
		done.push(record.id);
	}
	return done;
}

/** Current completed ids, sorted — plain accessor for non-React callers and tests. */
export function completedSessionIds(): readonly string[] {
	return completedIds;
}

/** The completed-but-unvisited ids, as a set for row lookups. */
export function useCompletedSessions(): ReadonlySet<string> {
	const ids = useSyncExternalStore(subscribeCompleted, getCompletedSnapshot, getCompletedSnapshot);
	return useMemo(() => new Set(ids), [ids]);
}

/**
 * Marks completion edges off the shared sessions store's updates (one
 * registry poll serves rail dots, record gate, alerts, and this). The first
 * sight of a listing is the baseline, not an edge; edges on the session
 * currently on screen are visited by definition and never marked.
 */
export function useCompletedSessionTracker(currentId: string): void {
	const sessions = useSessions().sessions;
	const prevRef = useRef<readonly SessionRecord[] | null>(null);

	useEffect(() => {
		if (!sessions) return;
		const edges = diffCompletedSessions(prevRef.current ?? sessions, sessions);
		prevRef.current = sessions;
		if (edges.length > 0) markCompletedSessions(edges.filter(id => id !== currentId));
		pruneCompletedSessions(sessions.filter(record => record.status === "live").map(record => record.id));
	}, [sessions, currentId]);
}
