/**
 * Per-browser "show folded sessions" preference for the session rail and the
 * quick switcher. Terminal (`exited`/`failed`) rows fold away by default so
 * dead agents stop cluttering the list — without touching the hub registry,
 * which is in-memory and shared by every guest (same constraint as
 * `hidden-sessions.ts`). One toggle drives both folded groups: the terminal
 * class as a whole and this browser's per-row hidden set (see also
 * `hidden-sessions.ts`, whose per-row removal stays orthogonal). The session
 * currently on screen is always exempt — its row must not vanish under the
 * viewer (enforced by the consumers).
 */
import { useSyncExternalStore } from "react";
import type { SessionStatus } from "./api";

// Legacy key name: it predates the toggle also revealing the hidden group.
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

/** Flip the folded-groups toggle; persists per browser. */
export function setShowExtras(value: boolean): void {
	if (show === value) return;
	show = value;
	persist();
	emit();
}

/** Reactive view of the folded-groups toggle; updates across all consumers. */
export function useShowExtras(): boolean {
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
	showExtras: boolean,
	currentId: string | undefined,
): T[] {
	const { active, ended } = partitionEnded(rows);
	return [...active, ...(showExtras ? ended : ended.filter(row => row.id === currentId))];
}

/**
 * Fallback session after deleting the one on screen: the newest active
 * session this browser has not hidden, else the newest ended one, else
 * `null` (nothing left — the caller goes home). Input order is the hub's
 * newest-first registry listing, so "first" is "most recent".
 */
export function pickFallbackSessionId(
	deletedId: string,
	sessions: readonly { id: string; status: SessionStatus }[] | null,
	hidden: ReadonlySet<string>,
): string | null {
	if (sessions === null) return null;
	const candidates = sessions.filter(row => row.id !== deletedId && !hidden.has(row.id));
	const { active, ended } = partitionEnded(candidates);
	return active[0]?.id ?? ended[0]?.id ?? null;
}

/**
 * Label for the single folded-groups toggle: collapsed counts what a click
 * reveals, expanded says what is shown; `null` when there is nothing to show.
 */
export function extrasLabel(endedCount: number, hiddenCount: number, shown: boolean): string | null {
	const parts: string[] = [];
	if (endedCount > 0) parts.push(`${endedCount} ended`);
	if (hiddenCount > 0) parts.push(`${hiddenCount} hidden`);
	if (parts.length === 0) return null;
	return shown ? `showing ${parts.join(" · ")} — back` : `${parts.join(" · ")} — show`;
}
