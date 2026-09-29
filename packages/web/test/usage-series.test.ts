/**
 * usage/series: pure chart-data shaping — downsampling, zero-fill bucketing,
 * provider stacking (hue ranks + rest merge), sparkline geometry, log heat
 * alpha, axis labels.
 */
import { describe, expect, test } from "bun:test";
import type { UsageProviderSeriesPoint } from "../src/hub/api";
import {
	assignProviderHues,
	bucketLabel,
	downsampleSeries,
	fillBuckets,
	heatAlpha,
	hourSpanLabel,
	sparklinePoints,
	stackByProvider,
} from "../src/hub/usage/series";

function point(timestamp: number, provider: string, cost: number, requests = 0): UsageProviderSeriesPoint {
	return { timestamp, provider, cost, totalTokens: 0, unpricedRequests: 0, requests };
}

describe("downsampleSeries", () => {
	test("keeps short series untouched", () => {
		const points = [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }];
		expect(downsampleSeries(points, 120)).toHaveLength(2);
	});

	test("sums equal groups down to the cap, keeping the first timestamp", () => {
		const points = Array.from({ length: 10 }, (_, index) => ({ timestamp: index, value: 1 }));
		const out = downsampleSeries(points, 4);
		expect(out).toHaveLength(4);
		expect(out[0]).toEqual({ timestamp: 0, value: 3 });
		expect(out.reduce((sum, bucket) => sum + bucket.value, 0)).toBe(10);
	});
});

describe("fillBuckets", () => {
	test("zero-fills the median-step gaps", () => {
		const filled = fillBuckets([
			{ timestamp: 0, value: 5 },
			{ timestamp: 10, value: 0 },
			{ timestamp: 30, value: 7 },
		]);
		expect(filled).toEqual([
			{ timestamp: 0, value: 5 },
			{ timestamp: 10, value: 0 },
			{ timestamp: 20, value: 0 },
			{ timestamp: 30, value: 7 },
		]);
	});

	test("leaves single points and step-less input untouched", () => {
		expect(fillBuckets([{ timestamp: 5, value: 1 }])).toHaveLength(1);
		expect(fillBuckets([
			{ timestamp: 5, value: 1 },
			{ timestamp: 5, value: 2 },
		])).toHaveLength(2);
	});
});

describe("stackByProvider", () => {
	test("ranks providers by total, merges the tail into rest", () => {
		const stack = stackByProvider(
			[
				point(0, "big", 40),
				point(0, "mid", 8),
				point(0, "small", 1),
				point(0, "tiny", 1),
				point(10, "big", 10),
				point(10, "mid", 2),
			],
			p => p.cost,
			2,
		);
		expect(stack.providers).toEqual(["big", "mid"]);
		expect(stack.columns.map(column => column.provider)).toEqual(["big", "mid", "rest"]);
		expect(stack.columns[2]?.values).toEqual([2, 0]);
		expect(stack.totals).toEqual([50, 12]);
	});

	test("zero-fills buckets where a provider is absent", () => {
		const stack = stackByProvider([point(0, "a", 5), point(10, "b", 5)], p => p.cost, 4);
		expect(stack.timestamps).toEqual([0, 10]);
		expect(stack.columns[0]?.values).toEqual([5, 0]);
		expect(stack.columns[1]?.values).toEqual([0, 5]);
	});
});

describe("sparklinePoints", () => {
	test("maps values into the box, y inverted", () => {
		const points = sparklinePoints([0, 10], 100, 10);
		expect(points).toBe("0,10 100,0");
	});

	test("flat series sit on the baseline", () => {
		const points = sparklinePoints([0, 0, 0], 90, 10);
		expect(points).toBe("0,10 45,10 90,10");
	});

	test("empty input is empty", () => {
		expect(sparklinePoints([], 10, 10)).toBe("");
	});
});

describe("heatAlpha", () => {
	test("log scaling keeps small non-zero values at or above the floor", () => {
		const alpha = heatAlpha(1, 1000);
		expect(alpha).toBeGreaterThanOrEqual(0.08);
		expect(alpha).toBeLessThan(0.5);
	});

	test("clamps at the floor and at one", () => {
		expect(heatAlpha(0, 100)).toBe(0);
		expect(heatAlpha(1000, 1000)).toBeCloseTo(1);
	});
});

describe("labels", () => {
	test("hour span wraps midnight", () => {
		expect(hourSpanLabel(22)).toBe("22:00–01:00");
		expect(hourSpanLabel(21, 3)).toBe("21:00–00:00");
	});

	test("bucket label switches between hour and day form", () => {
		const noon = new Date(2026, 8, 23, 17, 0).getTime();
		expect(bucketLabel(noon, 3_600_000)).toBe("17:00");
		expect(bucketLabel(noon, 86_400_000)).toMatch(/Sep 23|23 sep/i);
	});
});

describe("assignProviderHues", () => {
	test("cost-ranked hues with rest collapsing to -1", () => {
		const hues = assignProviderHues([
			{ provider: "a", totalCost: 1 },
			{ provider: "b", totalCost: 5 },
			{ provider: "c", totalCost: 3 },
			{ provider: "d", totalCost: 2 },
			{ provider: "e", totalCost: 0.5 },
		]);
		expect(hues.get("b")).toBe(0);
		expect(hues.get("c")).toBe(1);
		expect(hues.get("d")).toBe(2);
		expect(hues.get("a")).toBe(3);
		expect(hues.get("e")).toBe(-1);
	});
});
