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
import type {
	MachineDashboardStats,
	MachineProviderUsage,
	MachineUsageStats,
	UsageAgentTypeStats,
	UsageAggregate,
	UsageCostPoint,
	UsageFolderStats,
	UsageModelSeriesPoint,
	UsageModelStats,
	UsageProviderAggregate,
	UsageProviderHourPoint,
	UsageProviderSeriesPoint,
	UsageRecentRequest,
	UsageSessionSummary,
	UsageTimePoint,
} from "./api";

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

/** Sums partial aggregate rows (same formulas as {@link mergeMachineUsage}). */
function sumPartials(rows: readonly Partial<UsageAggregate>[]): UsageAggregate {
	const target = newAccumulator();
	for (const row of rows) {
		add(target, {
			totalRequests: row.totalRequests ?? 0,
			failedRequests: row.failedRequests ?? 0,
			errorRate: 0,
			totalInputTokens: row.totalInputTokens ?? 0,
			totalOutputTokens: row.totalOutputTokens ?? 0,
			totalCacheReadTokens: row.totalCacheReadTokens ?? 0,
			totalCacheWriteTokens: row.totalCacheWriteTokens ?? 0,
			cacheRate: 0,
			cacheSavings: 0,
			totalCost: row.totalCost ?? 0,
			unpricedRequests: row.unpricedRequests ?? 0,
			avgDuration: row.avgDuration ?? null,
			avgTtft: row.avgTtft ?? null,
			avgTokensPerSecond: row.avgTokensPerSecond ?? null,
			lastTimestamp: 0,
		});
	}
	return finish(target);
}

/**
 * Merges per-profile model-dashboard payloads for the "all profiles" view:
 * the base stats via {@link mergeMachineUsage}, folder/agent splits summed,
 * daily model and cost series summed per (bucket, provider, model) key.
 */
export function mergeModelDashboards(parts: readonly MachineDashboardStats[]): MachineDashboardStats {
	const base = mergeMachineUsage(parts);
	const folderRows = new Map<string, Partial<UsageAggregate>[]>();
	for (const part of parts) {
		for (const row of part.byFolder) {
			const bucket = folderRows.get(row.folder);
			if (bucket) bucket.push(row);
			else folderRows.set(row.folder, [row]);
		}
	}
	const folders: UsageFolderStats[] = [...folderRows.entries()].map(([folder, rows]) => ({ folder, ...sumPartials(rows) }));

	const agentTypes = new Map<string, UsageAgentTypeStats>();
	for (const part of parts) {
		for (const row of part.byAgentType) {
			const target = agentTypes.get(row.agentType) ?? {
				agentType: row.agentType,
				totalRequests: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalCost: 0,
			};
			target.totalRequests += row.totalRequests;
			target.totalInputTokens += row.totalInputTokens;
			target.totalOutputTokens += row.totalOutputTokens;
			target.totalCacheReadTokens += row.totalCacheReadTokens;
			target.totalCacheWriteTokens += row.totalCacheWriteTokens;
			target.totalCost += row.totalCost;
			agentTypes.set(row.agentType, target);
		}
	}

	const seriesKey = (point: { timestamp: number; provider: string; model: string }): string =>
		`${point.timestamp}\u0000${point.provider}\u0000${point.model}`;
	const modelSeries = new Map<string, UsageModelSeriesPoint>();
	const costSeries = new Map<string, UsageCostPoint>();
	for (const part of parts) {
		for (const point of part.modelSeries) {
			const key = seriesKey(point);
			const target = modelSeries.get(key);
			if (target) target.requests += point.requests;
			else modelSeries.set(key, { ...point });
		}
		for (const point of part.costSeries) {
			const key = seriesKey(point);
			const target = costSeries.get(key);
			if (target) {
				target.cost += point.cost;
				target.unpricedRequests += point.unpricedRequests;
				target.costInput += point.costInput;
				target.costOutput += point.costOutput;
				target.costCacheRead += point.costCacheRead;
				target.costCacheWrite += point.costCacheWrite;
				target.requests += point.requests;
			} else {
				costSeries.set(key, { ...point });
			}
		}
	}

	return {
		...base,
		byFolder: folders.sort((a, b) => b.totalCost - a.totalCost),
		byAgentType: [...agentTypes.values()].sort((a, b) => b.totalRequests - a.totalRequests),
		modelSeries: [...modelSeries.values()].sort((a, b) => a.timestamp - b.timestamp),
		costSeries: [...costSeries.values()].sort((a, b) => a.timestamp - b.timestamp),
	};
}

/**
 * Merges per-profile provider payloads: provider totals summed (distinct-model
 * counts take the max — summing would double-count cross-profile), hour burn
 * and daily series summed per key, tok/s re-weighted by requests.
 */
export function mergeProviderUsage(parts: readonly MachineProviderUsage[]): MachineProviderUsage {
	const providers = new Map<string, { row: UsageProviderAggregate; speedWeighted: number; speedWeight: number }>();
	const hourly = new Map<string, UsageProviderHourPoint>();
	const series = new Map<string, UsageProviderSeriesPoint>();
	for (const part of parts) {
		for (const row of part.providers) {
			let target = providers.get(row.provider);
			if (!target) {
				target = {
					row: { ...row },
					speedWeighted: (row.avgTokensPerSecond ?? 0) * row.totalRequests,
					speedWeight: row.totalRequests,
				};
				providers.set(row.provider, target);
				continue;
			}
			target.speedWeighted += (row.avgTokensPerSecond ?? 0) * row.totalRequests;
			target.speedWeight += row.totalRequests;
			target.row.totalRequests += row.totalRequests;
			target.row.failedRequests += row.failedRequests;
			target.row.models = Math.max(target.row.models, row.models);
			target.row.totalInputTokens += row.totalInputTokens;
			target.row.totalOutputTokens += row.totalOutputTokens;
			target.row.totalCacheReadTokens += row.totalCacheReadTokens;
			target.row.totalCacheWriteTokens += row.totalCacheWriteTokens;
			target.row.totalTokens += row.totalTokens;
			target.row.totalCost += row.totalCost;
			target.row.unpricedRequests += row.unpricedRequests;
		}
		for (const point of part.hourly) {
			const key = `${point.provider}\u0000${point.hour}`;
			const target = hourly.get(key);
			if (target) {
				target.totalTokens += point.totalTokens;
				target.outputTokens += point.outputTokens;
				target.requests += point.requests;
			} else {
				hourly.set(key, { ...point });
			}
		}
		for (const point of part.series) {
			const key = `${point.timestamp}\u0000${point.provider}`;
			const target = series.get(key);
			if (target) {
				target.totalTokens += point.totalTokens;
				target.cost += point.cost;
				target.unpricedRequests += point.unpricedRequests;
				target.requests += point.requests;
			} else {
				series.set(key, { ...point });
			}
		}
	}

	return {
		providers: [...providers.values()]
			.map(({ row, speedWeighted, speedWeight }) => ({
				...row,
				avgTokensPerSecond: speedWeight > 0 ? speedWeighted / speedWeight : null,
			}))
			.sort((a, b) => b.totalCost - a.totalCost),
		hourly: [...hourly.values()],
		series: [...series.values()].sort((a, b) => a.timestamp - b.timestamp),
	};
}

/** Flattens per-profile recent-request tails into one newest-first list. */
export function mergeRecentRequests(parts: readonly (readonly UsageRecentRequest[])[], cap: number): UsageRecentRequest[] {
	return parts.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, cap);
}

/**
 * Deduplicates per-profile session summaries by session file (a session lives
 * in exactly one profile's store, but a resumed file can appear twice) and
 * returns them costliest-first.
 */
export function mergeSessionSummaries(parts: readonly (readonly UsageSessionSummary[])[]): UsageSessionSummary[] {
	const byFile = new Map<string, UsageSessionSummary>();
	for (const row of parts.flat()) {
		const target = byFile.get(row.file);
		if (!target || row.costTotal > target.costTotal) byFile.set(row.file, row);
	}
	return [...byFile.values()].sort((a, b) => b.costTotal - a.costTotal);
}
