/**
 * Client-side hidden-session set for the session rail and the quick switcher.
 * Hiding is a per-browser preference in localStorage: the hub registry is
 * in-memory and shared by every guest, so hiding a session must not be a
 * registry mutation. Ids that no longer match any session are harmless and
 * simply never render.
 */
import { useSyncExternalStore } from "react";

const KEY = "omp-hub.hidden-sessions";

let ids: ReadonlySet<string> = load();
let snapshot: ReadonlySet<string> = ids;
const listeners = new Set<() => void>();

/** Tolerant loader: anything but a JSON array of strings reads as empty. */
export function parseStoredIds(raw: string | null): ReadonlySet<string> {
	if (!raw) return new Set();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
	} catch {
		return new Set();
	}
}

function load(): ReadonlySet<string> {
	try {
		return parseStoredIds(globalThis.localStorage?.getItem(KEY) ?? null);
	} catch {
		return new Set();
	}
}

function persist(): void {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify([...ids]));
	} catch {
		// Private mode / quota: hiding still works for this page load.
	}
}

function emit(): void {
	snapshot = ids;
	for (const listener of listeners) listener();
}

function replace(next: ReadonlySet<string>): void {
	ids = next;
	persist();
	emit();
}

/** Hide a session from the rail and switcher (this browser only). */
export function hideSession(id: string): void {
	if (!ids.has(id)) replace(new Set(ids).add(id));
}

/** Un-hide a session; unknown ids are ignored. */
export function showSession(id: string): void {
	if (!ids.has(id)) return;
	const next = new Set(ids);
	next.delete(id);
	replace(next);
}

/** Restore every hidden row in this browser, including ids no longer in the registry. */
export function showAllSessions(): void {
	if (ids.size > 0) replace(new Set());
}

/** Reactive view of the hidden set; updates across all consumers. */
export function useHiddenSessions(): ReadonlySet<string> {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}

/** Pure partition for a filtered listing: kept order, visible first. */
export function partitionHidden<T extends { id: string }>(
	rows: readonly T[],
	hidden: ReadonlySet<string>,
): { visible: T[]; hidden: T[] } {
	const visible: T[] = [];
	const hiddenRows: T[] = [];
	for (const row of rows) (hidden.has(row.id) ? hiddenRows : visible).push(row);
	return { visible, hidden: hiddenRows };
}
