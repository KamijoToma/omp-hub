/**
 * Client-side "all profiles" merge for the machine usage page
 * (docs/protocol.md §3 usage relay, 0.5.0+): the hub relays one stats payload
 * per profile, and the merged view is computed here.
 *
 * Sums are exact. Derived rates follow the dashboard's own formulas where the
 * inputs survive aggregation (`errorRate = failed/requests`, `cacheRate =
 * cacheRead/(input+cacheRead)`). `cacheSavings` and the latency/speed
 * averages are request-weighted means of the per-profile values — the
 * dashboard derives those from row-level sums the aggregate never carries, so
 * per-profile views stay the source of exact numbers.
 */
import type { MachineUsageStats, UsageAggregate, UsageModelStats, UsageTimePoint } from "./api";

/** Mutable sum accumulator over one {@link UsageAggregate}-shaped scope. */
interface Accumulator {
	totalRequests: number;
	failedRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	unpricedRequests: number;
	/** `cacheSavings * requests` weighted leftovers for the mean fields. */
	savingsWeighted: number;
	durationWeighted: number;
	durationWeight: number;
	ttftWeighted: number;
	ttftWeight: number;
	speedWeighted: number;
	speedWeight: number;
	lastTimestamp: number;
}

function newAccumulator(): Accumulator {
	return {
		totalRequests: 0,
		failedRequests: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalCost: 0,
		unpricedRequests: 0,
		savingsWeighted: 0,
		durationWeighted: 0,
		durationWeight: 0,
		ttftWeighted: 0,
		ttftWeight: 0,
		speedWeighted: 0,
		speedWeight: 0,
		lastTimestamp: 0,
	};
}

function add(target: Accumulator, agg: UsageAggregate): void {
	const weight = agg.totalRequests;
	target.totalRequests += weight;
	target.failedRequests += agg.failedRequests;
	target.totalInputTokens += agg.totalInputTokens;
	target.totalOutputTokens += agg.totalOutputTokens;
	target.totalCacheReadTokens += agg.totalCacheReadTokens;
	target.totalCacheWriteTokens += agg.totalCacheWriteTokens;
	target.totalCost += agg.totalCost;
	target.unpricedRequests += agg.unpricedRequests;
	target.savingsWeighted += agg.cacheSavings * weight;
	if (agg.avgDuration !== null) {
		target.durationWeighted += agg.avgDuration * weight;
		target.durationWeight += weight;
	}
	if (agg.avgTtft !== null) {
		target.ttftWeighted += agg.avgTtft * weight;
		target.ttftWeight += weight;
	}
	if (agg.avgTokensPerSecond !== null) {
		target.speedWeighted += agg.avgTokensPerSecond * weight;
		target.speedWeight += weight;
	}
	if (agg.lastTimestamp > target.lastTimestamp) target.lastTimestamp = agg.lastTimestamp;
}

function finish(target: Accumulator): UsageAggregate {
	const total = target.totalRequests;
	const mean = (weighted: number, weight: number): number | null => (weight > 0 ? weighted / weight : null);
	return {
		totalRequests: total,
		failedRequests: target.failedRequests,
		errorRate: total > 0 ? target.failedRequests / total : 0,
		totalInputTokens: target.totalInputTokens,
		totalOutputTokens: target.totalOutputTokens,
		totalCacheReadTokens: target.totalCacheReadTokens,
		totalCacheWriteTokens: target.totalCacheWriteTokens,
		cacheRate: target.totalInputTokens + target.totalCacheReadTokens > 0
			? target.totalCacheReadTokens / (target.totalInputTokens + target.totalCacheReadTokens)
			: 0,
		cacheSavings: total > 0 ? target.savingsWeighted / total : 0,
		totalCost: target.totalCost,
		unpricedRequests: target.unpricedRequests,
		avgDuration: mean(target.durationWeighted, target.durationWeight),
		avgTtft: mean(target.ttftWeighted, target.ttftWeight),
		avgTokensPerSecond: mean(target.speedWeighted, target.speedWeight),
		lastTimestamp: target.lastTimestamp,
	};
}

/**
 * Merges one or more per-profile stats payloads into a single view. An empty
 * input yields an all-zero payload; a single part is normalized (not aliased)
 * so callers can treat the result as owned.
 */
export function mergeMachineUsage(parts: readonly MachineUsageStats[]): MachineUsageStats {
	const overall = newAccumulator();
	const models = new Map<string, Accumulator & { model: string; provider: string }>();
	const series = new Map<number, UsageTimePoint>();

	for (const part of parts) {
		add(overall, part.overall);
		for (const row of part.byModel) {
			const key = `${row.provider}\u0000${row.model}`;
			let target = models.get(key);
			if (!target) {
				target = { ...newAccumulator(), model: row.model, provider: row.provider };
				models.set(key, target);
			}
			add(target, row);
		}
		for (const point of part.timeSeries) {
			const bucket = series.get(point.timestamp);
			if (bucket) {
				bucket.requests += point.requests;
				bucket.errors += point.errors;
				bucket.tokens += point.tokens;
				bucket.cost += point.cost;
			} else {
				series.set(point.timestamp, { ...point });
			}
		}
	}

	const byModel: UsageModelStats[] = [...models.values()]
		.map(target => ({ model: target.model, provider: target.provider, ...finish(target) }))
		.sort((a, b) => b.totalRequests - a.totalRequests);
	const timeSeries: UsageTimePoint[] = [...series.values()].sort((a, b) => a.timestamp - b.timestamp);

	return { overall: finish(overall), byModel, timeSeries };
}
