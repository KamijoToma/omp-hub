/**
 * `stats-prefs` — the per-browser checkbox set behind the stats bar: corrupt
 * or unknown stored payloads fall back to the default set (a bad write must
 * never hide the bar), and toggling persists the exact set, including empty.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_STATS_METRICS, parseStoredMetricIds, toggleStatsMetric } from "../src/lib/stats-prefs";

// Installed before any toggle; module-level load() already ran against an
// absent localStorage, which is the same default-set start a fresh page gets.
const backing = new Map<string, string>();
globalThis.localStorage = {
	getItem: (key: string) => backing.get(key) ?? null,
	setItem: (key: string, value: string) => void backing.set(key, value),
	removeItem: (key: string) => void backing.delete(key),
	clear: () => backing.clear(),
	key: () => null,
	length: 0,
	// Library boundary: a minimal Storage stand-in for the two calls the store makes.
} as unknown as Storage;

const KEY = "omp.stats-bar";

describe("parseStoredMetricIds", () => {
	test("absent key reads as unconfigured", () => {
		expect(parseStoredMetricIds(null)).toBeNull();
	});

	test("corrupt payloads read as unconfigured", () => {
		expect(parseStoredMetricIds("not json")).toBeNull();
		expect(parseStoredMetricIds("42")).toBeNull();
		expect(parseStoredMetricIds('{"a":1}')).toBeNull();
		expect(parseStoredMetricIds('["tokens", "mystery-metric"]')).toBeNull();
	});

	test("a stored array round trips, including the explicit empty set", () => {
		expect([...(parseStoredMetricIds('["cost","ttft"]') ?? [])]).toEqual(["cost", "ttft"]);
		expect(parseStoredMetricIds("[]")?.size).toBe(0);
	});
});

describe("toggleStatsMetric", () => {
	test("toggling persists the exact set", () => {
		toggleStatsMetric("reqs");
		expect(JSON.parse(backing.get(KEY)!)).toEqual([...DEFAULT_STATS_METRICS, "reqs"]);

		toggleStatsMetric("tokens");
		expect(JSON.parse(backing.get(KEY)!).sort()).toEqual(
			[...DEFAULT_STATS_METRICS.filter(id => id !== "tokens"), "reqs"].sort(),
		);

		// Toggling back restores the default set exactly.
		toggleStatsMetric("reqs");
		toggleStatsMetric("tokens");
		expect(JSON.parse(backing.get(KEY)!).sort()).toEqual([...DEFAULT_STATS_METRICS].sort());
	});
});
