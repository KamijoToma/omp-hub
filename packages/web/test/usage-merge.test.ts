/**
 * mergeMachineUsage (§3 usage relay "all profiles" view): exact sums,
 * dashboard-derived rate formulas, request-weighted means, and the
 * by-model/timeseries keying.
 */
import { describe, expect, test } from "bun:test";
import type {
	MachineDashboardStats,
	MachineProviderUsage,
	MachineUsageStats,
	UsageAggregate,
	UsageModelStats,
	UsageRecentRequest,
	UsageSessionSummary,
} from "../src/hub/api";
import {
	mergeMachineUsage,
	mergeModelDashboards,
	mergeProviderUsage,
	mergeRecentRequests,
	mergeSessionSummaries,
} from "../src/hub/usage-merge";

function agg(overrides: Partial<UsageAggregate> = {}): UsageAggregate {
	return {
		totalRequests: 0,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: 0,
		cacheSavings: 0,
		totalCost: 0,
		unpricedRequests: 0,
		avgDuration: null,
		avgTtft: null,
		avgTokensPerSecond: null,
		lastTimestamp: 0,
		...overrides,
	};
}

function stats(overall: UsageAggregate, byModel: MachineUsageStats["byModel"] = [], timeSeries: MachineUsageStats["timeSeries"] = []): MachineUsageStats {
	return { overall, byModel, timeSeries };
}

describe("mergeMachineUsage", () => {
	test("empty input yields an all-zero payload", () => {
		const merged = mergeMachineUsage([]);
		expect(merged.overall).toMatchObject({
			totalRequests: 0,
			errorRate: 0,
			cacheRate: 0,
			avgDuration: null,
			lastTimestamp: 0,
		});
		expect(merged.byModel).toEqual([]);
		expect(merged.timeSeries).toEqual([]);
	});

	test("sums counters exactly and recomputes the dashboard rate formulas", () => {
		const merged = mergeMachineUsage([
			stats(agg({
				totalRequests: 10,
				failedRequests: 1,
				errorRate: 0.1,
				totalInputTokens: 100,
				totalCacheReadTokens: 300,
				totalCacheWriteTokens: 25,
				cacheRate: 0.75,
			})),
			stats(agg({
				totalRequests: 30,
				failedRequests: 3,
				errorRate: 0.1,
				totalInputTokens: 500,
				totalCacheReadTokens: 100,
				cacheRate: 0.166,
			})),
		]);

		expect(merged.overall.totalRequests).toBe(40);
		expect(merged.overall.failedRequests).toBe(4);
		// failed/requests, recomputed from sums — not a mean of the rates.
		expect(merged.overall.errorRate).toBeCloseTo(0.1);
		// cacheRead/(input+cacheRead) from the summed tokens: 400/1000.
		expect(merged.overall.cacheRate).toBeCloseTo(0.4);
		expect(merged.overall.totalInputTokens).toBe(600);
	});

	test("weights latency means by requests and keeps the newest timestamp", () => {
		const merged = mergeMachineUsage([
			stats(agg({ totalRequests: 10, avgDuration: 2, avgTtft: 0.5, avgTokensPerSecond: 40, lastTimestamp: 1_000 })),
			stats(agg({ totalRequests: 30, avgDuration: 4, avgTtft: null, avgTokensPerSecond: null, lastTimestamp: 5_000 })),
		]);

		// (2×10 + 4×30) / 40 = 3.5; null contributors drop out of the mean.
		expect(merged.overall.avgDuration).toBeCloseTo(3.5);
		expect(merged.overall.avgTtft).toBeCloseTo(0.5);
		expect(merged.overall.avgTokensPerSecond).toBeCloseTo(40);
		expect(merged.overall.lastTimestamp).toBe(5_000);
	});

	test("groups by-model rows across profiles and sorts by requests", () => {
		const merged = mergeMachineUsage([
			stats(agg(), [
				{ ...agg({ totalRequests: 5, failedRequests: 1 }), model: "m-a", provider: "p1" },
				{ ...agg({ totalRequests: 2 }), model: "m-b", provider: "p1" },
			]),
			stats(agg(), [
				{ ...agg({ totalRequests: 7, failedRequests: 1 }), model: "m-a", provider: "p1" },
				{ ...agg({ totalRequests: 9 }), model: "m-a", provider: "p2" },
			]),
		]);

		expect(merged.byModel.map(row => [row.model, row.provider, row.totalRequests])).toEqual([
			["m-a", "p1", 12],
			["m-a", "p2", 9],
			["m-b", "p1", 2],
		]);
		// Same provider+model merges; same model on another provider stays apart.
		expect(merged.byModel[0]!.failedRequests).toBe(2);
		expect(merged.byModel[0]!.errorRate).toBeCloseTo(2 / 12);
	});

	test("merges the timeseries by bucket and keeps it ascending", () => {
		const merged = mergeMachineUsage([
			stats(agg(), [], [
				{ timestamp: 3_600_000, requests: 2, errors: 0, tokens: 10, cost: 0.5 },
				{ timestamp: 7_200_000, requests: 1, errors: 0, tokens: 5, cost: 0.25 },
			]),
			stats(agg(), [], [
				{ timestamp: 0, requests: 4, errors: 1, tokens: 20, cost: 1 },
				{ timestamp: 3_600_000, requests: 3, errors: 1, tokens: 15, cost: 0.75 },
			]),
		]);

		expect(merged.timeSeries).toEqual([
			{ timestamp: 0, requests: 4, errors: 1, tokens: 20, cost: 1 },
			{ timestamp: 3_600_000, requests: 5, errors: 1, tokens: 25, cost: 1.25 },
			{ timestamp: 7_200_000, requests: 1, errors: 0, tokens: 5, cost: 0.25 },
		]);
	});

	test("does not alias the input payloads", () => {
		const part = stats(agg({ totalRequests: 1 }), [], [{ timestamp: 1, requests: 1, errors: 0, tokens: 1, cost: 1 }]);
		const merged = mergeMachineUsage([part]);
		merged.overall.totalRequests = 99;
		merged.timeSeries[0]!.requests = 99;
		expect(part.overall.totalRequests).toBe(1);
		expect(part.timeSeries[0]!.requests).toBe(1);
	});
});

describe("mergeModelDashboards", () => {
	function dash(model: string, cost: number, requests: number, folderCost = cost): MachineDashboardStats {
		return {
			overall: agg({ totalRequests: requests, totalCost: cost }),
			byModel: [{ ...agg({ totalRequests: requests, totalCost: cost }), model, provider: "p" }],
			timeSeries: [],
			byFolder: [{ ...agg({ totalRequests: requests, totalCost: folderCost }), folder: "/proj" }],
			byAgentType: [{ agentType: "main", totalRequests: requests, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCost: cost }],
			modelSeries: [{ timestamp: 1, model, provider: "p", requests }],
			costSeries: [{ timestamp: 1, model, provider: "p", cost, unpricedRequests: 1, costInput: cost, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, requests }],
		};
	}

	test("sums folder, agent-type, and series across profiles", () => {
		const merged = mergeModelDashboards([dash("a", 10, 5), dash("a", 1, 2)]);
		expect(merged.overall.totalCost).toBeCloseTo(11);
		expect(merged.byFolder[0]?.folder).toBe("/proj");
		expect(merged.byFolder[0]?.totalCost).toBeCloseTo(11);
		expect(merged.byAgentType[0]?.totalCost).toBeCloseTo(11);
		expect(merged.modelSeries).toEqual([{ timestamp: 1, model: "a", provider: "p", requests: 7 }]);
		expect(merged.costSeries[0]?.cost).toBeCloseTo(11);
		expect(merged.costSeries[0]?.unpricedRequests).toBe(2);
	});

	test("keeps distinct models as distinct series rows", () => {
		const merged = mergeModelDashboards([dash("a", 10, 5), dash("b", 1, 2)]);
		expect(merged.modelSeries.map(row => row.model).sort()).toEqual(["a", "b"]);
		expect(merged.costSeries.map(row => row.cost).sort()).toEqual([1, 10]);
	});
});

describe("mergeProviderUsage", () => {
	function providerPart(cost: number, speed: number | null): MachineProviderUsage {
		return {
			providers: [{
				provider: "p",
				totalRequests: 2,
				failedRequests: 0,
				models: 1,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalTokens: 10,
				totalCost: cost,
				unpricedRequests: 0,
				avgTokensPerSecond: speed,
			}],
			hourly: [{ provider: "p", hour: 21, totalTokens: 5, outputTokens: 0, requests: 1 }],
			series: [{ timestamp: 1, provider: "p", totalTokens: 10, cost, unpricedRequests: 0, requests: 2 }],
		};
	}

	test("sums totals, re-weights speed, maxes model counts", () => {
		const merged = mergeProviderUsage([providerPart(10, 80), providerPart(6, 100)]);
		const row = merged.providers[0]!;
		expect(row.totalCost).toBeCloseTo(16);
		expect(row.totalRequests).toBe(4);
		expect(row.models).toBe(1);
		expect(row.avgTokensPerSecond).toBeCloseTo((80 * 2 + 100 * 2) / 4);
		expect(merged.hourly[0]?.totalTokens).toBe(10);
		expect(merged.series[0]?.cost).toBeCloseTo(16);
	});
});

describe("mergeRecentRequests + mergeSessionSummaries", () => {
	test("recent: newest first, capped", () => {
		const row = (id: number, timestamp: number): UsageRecentRequest => ({
			id, model: "m", provider: "p", timestamp, duration: 0, ttft: null,
			stopReason: "stop", errorMessage: null, agentType: "main", costUnpriced: false,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		});
		expect(mergeRecentRequests([[row(1, 10), row(2, 30)], [row(3, 20)]], 2).map(row => row.id)).toEqual([2, 3]);
	});

	test("sessions: deduped by file, costliest first", () => {
		const session = (file: string, costTotal: number): UsageSessionSummary => ({
			file, folder: "/f", title: file, startedAt: 0, endedAt: 0,
			requests: 0, toolCalls: 0, subagents: 0, totalTokens: 0, costTotal,
			unpricedRequests: 0, models: [],
		});
		const merged = mergeSessionSummaries([[session("/a", 5)], [session("/a", 7), session("/b", 2)]]);
		expect(merged.map(session => session.file)).toEqual(["/a", "/b"]);
		expect(merged[0]?.costTotal).toBe(7);
	});
});
