/**
 * Per-browser visibility set for the stats bar's metrics, persisted in
 * localStorage (same shape as `hub/hidden-sessions.ts`, but the bar renders on
 * `/join` too, so the key is collab-neutral). An absent key means "never
 * configured" → the default set; an explicitly empty set means the user
 * unchecked everything and the bar stays hidden.
 */
import { useSyncExternalStore } from "react";

const KEY = "omp.stats-bar";

/** One toggleable metric chip on the stats bar. */
export type StatsMetricId =
	| "tokens" // Σ(input + output + cacheWrite)
	| "cost" // cumulative estimated spend
	| "ttft" // last request's time-to-first-token
	| "cache" // cache hit rate + cold-cache miss marker
	| "ctx" // context tokens used / window
	| "inout" // in/out token split
	| "rate" // average output tok/s
	| "reqs" // request count
	| "elapsed"; // Σ request wall time

export interface StatsMetricDef {
	id: StatsMetricId;
	label: string;
	/** One-line description shown under the checkbox. */
	description: string;
}

/** Popover rows, display order. */
export const STATS_METRICS: readonly StatsMetricDef[] = [
	{ id: "tokens", label: "tokens", description: "cumulative prompt + output tokens (cache reads excluded, TUI parity)" },
	{ id: "cost", label: "cost", description: "estimated session spend, priced from provider tables" },
	{ id: "ttft", label: "ttft", description: "time to first token of the latest request (average in the tooltip)" },
	{ id: "cache", label: "cache", description: "cache hit rate; flags when the cache goes cold mid-session" },
	{ id: "ctx", label: "context", description: "context window tokens used / total (the header gauge shows the percent)" },
	{ id: "inout", label: "in / out", description: "uncached prompt and generated token split" },
	{ id: "rate", label: "tok/s", description: "average output rate across requests" },
	{ id: "reqs", label: "requests", description: "how many model requests this session made" },
	{ id: "elapsed", label: "elapsed", description: "total model request time (excludes idle between turns)" },
];

/** Checked on first visit: the four headline metrics. */
export const DEFAULT_STATS_METRICS: readonly StatsMetricId[] = ["tokens", "cost", "ttft", "cache"];

const KNOWN: ReadonlySet<string> = new Set(STATS_METRICS.map(metric => metric.id));

/**
 * Stored JSON array → metric-id set. `null` (absent key, corrupt payload, or
 * any unknown id) reads as "unconfigured" so a bad write can never hide the
 * bar; callers fall back to {@link DEFAULT_STATS_METRICS}.
 */
export function parseStoredMetricIds(raw: string | null): ReadonlySet<StatsMetricId> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const ids = new Set<StatsMetricId>();
		for (const entry of parsed) {
			if (typeof entry !== "string" || !KNOWN.has(entry)) return null;
			ids.add(entry as StatsMetricId);
		}
		return ids;
	} catch {
		return null;
	}
}

function load(): ReadonlySet<StatsMetricId> {
	try {
		return parseStoredMetricIds(globalThis.localStorage?.getItem(KEY) ?? null) ?? new Set(DEFAULT_STATS_METRICS);
	} catch {
		return new Set(DEFAULT_STATS_METRICS);
	}
}

let visible: ReadonlySet<StatsMetricId> = load();
let snapshot: ReadonlySet<StatsMetricId> = visible;
const listeners = new Set<() => void>();

function persist(): void {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify([...visible]));
	} catch {
		// Private mode / quota: the choice still holds for this page load.
	}
}

function emit(): void {
	snapshot = visible;
	for (const listener of listeners) listener();
}

/** Flip one metric's visibility and persist. */
export function toggleStatsMetric(id: StatsMetricId): void {
	const next = new Set(visible);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	visible = next;
	persist();
	emit();
}

/** Reactive view of the visible set; updates across all consumers. */
export function useStatsPrefs(): ReadonlySet<StatsMetricId> {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}
