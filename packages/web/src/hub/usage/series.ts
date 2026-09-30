/**
 * Pure chart-data shaping for the usage page — bucket zero-filling,
 * provider stacking with the fixed categorical palette, sparkline geometry,
 * and heat-cell alpha. No React, no DOM beyond string geometry output; every
 * function is deterministic and unit-tested.
 *
 * Bucket rule: series arrive pre-bucketed by the dashboard on each profile's
 * local clock, so merge/zero-fill keys on exact timestamps. The "all
 * profiles" merge (usage-merge.ts) guarantees one shared time axis; the
 * downsample here keeps long ranges renderable by summing equal groups.
 */
import type { UsageProviderSeriesPoint } from "../api";

/** Consecutive same-size groups summed down to at most `maxBuckets` points. */
export function downsampleSeries(points: readonly { timestamp: number; value: number }[], maxBuckets: number): { timestamp: number; value: number }[] {
	if (points.length <= maxBuckets) return [...points];
	const groupSize = Math.ceil(points.length / maxBuckets);
	const out: { timestamp: number; value: number }[] = [];
	for (let index = 0; index < points.length; index += groupSize) {
		let value = 0;
		for (const point of points.slice(index, index + groupSize)) value += point.value;
		out.push({ timestamp: points[index]!.timestamp, value });
	}
	return out;
}

/**
 * Zero-fills a per-timestamp series onto its natural step (the smallest gap
 * between consecutive buckets — dashboards emit contiguous buckets with
 * occasional missing rows), so idle days/hours render as visible gaps
 * instead of teleporting columns. Single-point series come back untouched.
 */
export function fillBuckets(points: readonly { timestamp: number; value: number }[]): { timestamp: number; value: number }[] {
	if (points.length < 2) return [...points];
	const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
	let step = Number.POSITIVE_INFINITY;
	for (let index = 1; index < sorted.length; index++) {
		const gap = sorted[index]!.timestamp - sorted[index - 1]!.timestamp;
		if (gap > 0 && gap < step) step = gap;
	}
	if (!Number.isFinite(step)) return sorted;
	const byTime = new Map(sorted.map(point => [point.timestamp, point.value]));
	const filled: { timestamp: number; value: number }[] = [];
	for (let time = sorted[0]!.timestamp; time <= sorted[sorted.length - 1]!.timestamp; time += step) {
		filled.push({ timestamp: time, value: byTime.get(time) ?? 0 });
	}
	return filled;
}

/** One stacked provider column set: top providers keep their own hue, the tail merges. */
export interface ProviderStack {
	/** Zero-filled bucket timestamps (x axis). */
	timestamps: number[];
	/** Kept providers in hue order; `rest` merges everyone past {@link maxProviders}. */
	providers: string[];
	/** Per-provider values aligned with `timestamps`; the last entry is `rest` when present. */
	columns: { provider: string; values: number[] }[];
	/** Per-bucket grand totals (all providers, kept + rest). */
	totals: number[];
}

/**
 * Stacks per-provider series for the hero chart: providers ranked by total
 * value, the top {@link maxProviders} kept distinct, the remainder summed as
 * `rest`. Buckets are the union of seen timestamps, zero-filled.
 */
export function stackByProvider(
	points: readonly UsageProviderSeriesPoint[],
	valueOf: (point: UsageProviderSeriesPoint) => number,
	maxProviders = 4,
): ProviderStack {
	const totalsByProvider = new Map<string, number>();
	const buckets = new Map<number, Map<string, number>>();
	for (const point of points) {
		totalsByProvider.set(point.provider, (totalsByProvider.get(point.provider) ?? 0) + valueOf(point));
		let bucket = buckets.get(point.timestamp);
		if (!bucket) {
			bucket = new Map();
			buckets.set(point.timestamp, bucket);
		}
		bucket.set(point.provider, (bucket.get(point.provider) ?? 0) + valueOf(point));
	}

	const ranked = [...totalsByProvider.entries()].sort((a, b) => b[1] - a[1]);
	const kept = ranked.slice(0, maxProviders).map(([provider]) => provider);
	const hasRest = ranked.length > kept.length;
	const timestamps = [...buckets.keys()].sort((a, b) => a - b);
	const columns = kept.map(provider => ({
		provider,
		values: timestamps.map(time => buckets.get(time)!.get(provider) ?? 0),
	}));
	if (hasRest) {
		columns.push({
			provider: "rest",
			values: timestamps.map(time => {
				let sum = 0;
				for (const [provider, value] of buckets.get(time)!) if (!kept.includes(provider)) sum += value;
				return sum;
			}),
		});
	}
	return {
		timestamps,
		providers: kept,
		columns,
		totals: timestamps.map(time => [...buckets.get(time)!.values()].reduce((sum, value) => sum + value, 0)),
	};
}

/**
 * Polyline `points` string for a sparkline of `values` in a `width×height`
 * box (y grows downward). Zero-total series render flat on the baseline.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
	if (values.length === 0) return "";
	const max = Math.max(...values, 0);
	const step = values.length > 1 ? width / (values.length - 1) : width;
	return values
		.map((value, index) => {
			const x = values.length > 1 ? index * step : width / 2;
			const y = max > 0 ? height - (value / max) * height : height;
			return `${(Math.round(x * 10) / 10).toString()},${(Math.round(y * 10) / 10).toString()}`;
		})
		.join(" ");
}

/**
 * Log-scaled heat-cell opacity in `[floor, 1]`: linear alpha flattens the
 * tail of hour-of-day burn, log keeps midnight cliffs and noon hum readable
 * in the same grid.
 */
export function heatAlpha(value: number, max: number, floor = 0.08): number {
	if (max <= 0 || value <= 0) return 0;
	return floor + (1 - floor) * (Math.log10(value) / Math.log10(max));
}

/** `21:00–00:00` style label for `hours` starting at `startHour` (wraps midnight). */
export function hourSpanLabel(startHour: number, hours = 3): string {
	const end = (startHour + hours) % 24;
	return `${String(startHour).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00`;
}

/**
 * Stable provider→hue-index map (0–3) ranked by cost, for every
 * provider-colored element on the tab (hero stack, ledger dots, heat rows).
 * Providers past the palette collapse to `-1` ("rest", neutral gray) — the
 * same rule {@link stackByProvider} applies to its columns.
 */
export function assignProviderHues<T extends { provider: string; totalCost: number }>(
	aggregates: readonly T[],
	max = 4,
): Map<string, number> {
	const ranked = [...aggregates].sort((a, b) => b.totalCost - a.totalCost);
	const map = new Map<string, number>();
	ranked.forEach((row, index) => map.set(row.provider, index < max ? index : -1));
	return map;
}

/** Bucket axis label: `17:00` for sub-2h steps, `Sep 23` otherwise. */
export function bucketLabel(timestamp: number, stepMs: number): string {
	const date = new Date(timestamp);
	if (stepMs < 2 * 3_600_000) {
		return `${String(date.getHours()).padStart(2, "0")}:00`;
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
