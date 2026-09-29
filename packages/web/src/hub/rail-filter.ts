/**
 * Per-browser "show ended sessions" preference for the session rail and the
 * quick switcher. Terminal (`exited`/`failed`) rows fold away by default so
 * dead agents stop cluttering the list — without touching the hub registry,
 * which is in-memory and shared by every guest (same constraint as
 * `hidden-sessions.ts`; see also the per-row hidden set, which stays
 * orthogonal: it removes one session for this browser, this toggle folds the
 * whole terminal class). The session currently on screen is always exempt —
 * its row must not vanish under the viewer (enforced by the consumers).
 */
import { useSyncExternalStore } from "react";
import type { SessionStatus } from "./api";

const KEY = "omp-hub.rail.show-ended";

let show: boolean = load();
let snapshot: boolean = show;
const listeners = new Set<() => void>();

function load(): boolean {
	try {
		return globalThis.localStorage?.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

function persist(): void {
	try {
		globalThis.localStorage?.setItem(KEY, show ? "1" : "0");
	} catch {
		// Private mode / quota: the toggle still works for this page load.
	}
}

function emit(): void {
	snapshot = show;
	for (const listener of listeners) listener();
}

/** Flip the ended-rows fold; persists per browser. */
export function setShowEnded(value: boolean): void {
	if (show === value) return;
	show = value;
	persist();
	emit();
}

/** Reactive view of the fold toggle; updates across all consumers. */
export function useShowEnded(): boolean {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}

/** Terminal statuses the fold applies to. */
export function isEndedStatus(status: SessionStatus): boolean {
	return status === "exited" || status === "failed";
}

/** Pure split of a filtered listing into active and ended rows, order kept. */
export function partitionEnded<T extends { id: string; status: SessionStatus }>(
	rows: readonly T[],
): { active: T[]; ended: T[] } {
	const active: T[] = [];
	const ended: T[] = [];
	for (const row of rows) (isEndedStatus(row.status) ? ended : active).push(row);
	return { active, ended };
}

/**
 * Final rail ordering: active rows first, then the ended ones. Ended rows fold
 * by default; the session currently on screen never folds away — its row must
 * not vanish under the viewer, so it is the one ended row kept when folded.
 */
export function railRowsOrdered<T extends { id: string; status: SessionStatus }>(
	rows: readonly T[],
	showEnded: boolean,
	currentId: string | undefined,
): T[] {
	const { active, ended } = partitionEnded(rows);
	return [...active, ...(showEnded ? ended : ended.filter(row => row.id === currentId))];
}
