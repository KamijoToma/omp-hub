/**
 * assembleStatistics: the "all profiles" view-model merge — per-type merging
 * of partially-failed relay batches, source tracking, and failure counting.
 */
import { describe, expect, test } from "bun:test";
import type { MachineDashboardStats, MachineProviderUsage, UsageRecentRequest } from "../src/hub/api";
import { assembleStatistics, type StatisticsParts } from "../src/hub/usage/assemble";

function dashboard(model: string, cost: number, requests: number): MachineDashboardStats {
	return {
		overall: {
			totalRequests: requests,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			cacheSavings: 0,
			totalCost: cost,
			unpricedRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			lastTimestamp: 0,
		},
		byModel: [
			{
				model,
				provider: "p",
				totalRequests: requests,
				failedRequests: 0,
				errorRate: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				cacheRate: 0,
				cacheSavings: 0,
				totalCost: cost,
				unpricedRequests: 0,
				avgDuration: null,
				avgTtft: null,
				avgTokensPerSecond: null,
				lastTimestamp: 0,
			},
		],
		timeSeries: [],
		byFolder: [{ folder: "/proj", totalRequests: requests, failedRequests: 0, errorRate: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, cacheRate: 0, cacheSavings: 0, totalCost: cost, unpricedRequests: 0, avgDuration: null, avgTtft: null, avgTokensPerSecond: null, lastTimestamp: 0 }],
		byAgentType: [],
		modelSeries: [],
		costSeries: [{ timestamp: 1, model, provider: "p", cost, unpricedRequests: 0, costInput: cost, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, requests }],
	};
}

function providerPart(cost: number): MachineProviderUsage {
	return {
		providers: [{ provider: "p", totalRequests: 1, failedRequests: 0, models: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalTokens: 0, totalCost: cost, unpricedRequests: 0, avgTokensPerSecond: null }],
		hourly: [{ provider: "p", hour: 21, totalTokens: 10, outputTokens: 0, requests: 1 }],
		series: [{ timestamp: 1, provider: "p", totalTokens: 0, cost, unpricedRequests: 0, requests: 1 }],
	};
}

function recent(id: number, timestamp: number): UsageRecentRequest {
	return {
		id,
		model: "m",
		provider: "p",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		agentType: "main",
		costUnpriced: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
}

function parts(overrides: Partial<StatisticsParts> = {}): StatisticsParts {
	// Array-typed parts default to "answered, empty" (a fulfilled relay call);
	// null means the call failed and the assembler must count it.
	return { dashboard: null, providers: null, recent: [], errors: [], sessions: [], ...overrides };
}

describe("assembleStatistics", () => {
	test("merges dashboards and providers across profiles", () => {
		const assembled = assembleStatistics([
			parts({ dashboard: dashboard("a", 10, 5), providers: providerPart(10) }),
			parts({ dashboard: dashboard("b", 1, 2), providers: providerPart(1) }),
		]);
		expect(assembled.dashboard?.overall.totalCost).toBeCloseTo(11);
		expect(assembled.dashboard?.overall.totalRequests).toBe(7);
		expect(assembled.dashboard?.byFolder).toHaveLength(1);
		expect(assembled.dashboard?.byFolder[0]?.totalCost).toBeCloseTo(11);
		expect(assembled.providers?.series).toHaveLength(1);
		expect(assembled.providers?.series[0]?.cost).toBeCloseTo(11);
		expect(assembled.failedCalls).toBe(0);
	});

	test("tracks failures and sources per type", () => {
		const assembled = assembleStatistics([
			parts({ dashboard: dashboard("a", 1, 1), recent: [recent(1, 5), recent(2, 9)] }),
			parts({ dashboard: dashboard("a", 1, 1) }),
		]);
		// 2 profiles × 5 calls: providers failed on both, everything else answered.
		expect(assembled.failedCalls).toBe(2);
		expect(assembled.sources).toEqual(["api/sessions", "api/stats/errors", "api/stats/model-dashboard", "api/stats/recent"]);
		expect(assembled.recent?.map(row => row.id)).toEqual([2, 1]);
		expect(assembled.errors).toEqual([]);
		expect(assembled.sessions).toEqual([]);
	});

	test("interleaves recent requests newest-first with a cap", () => {
		const assembled = assembleStatistics([
			parts({ recent: [recent(1, 100), recent(2, 300)] }),
			parts({ recent: [recent(3, 200)] }),
		]);
		expect(assembled.recent?.map(row => row.id)).toEqual([2, 3, 1]);
	});
});
