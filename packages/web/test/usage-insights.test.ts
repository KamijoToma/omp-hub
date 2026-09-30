/**
 * usage/insights: pure derivations for the glanceable layers — fraction
 * normalization (provider scale chaos), health chips/verdict, peak burn
 * window, guarded capacity callouts, fleet counts, window verdicts, error
 * kinds, reset countdowns.
 */
import { describe, expect, test } from "bun:test";
import type { SubscriptionLimit, SubscriptionUsage, UsageAggregate, UsageModelStats, UsageProviderHourPoint, UsageWindowInsight } from "../src/hub/api";
import {
	deriveCallouts,
	deriveHealth,
	errorKind,
	fleetQuotaCounts,
	limitFraction,
	normalizeFraction,
	peakBurnWindow,
	resetCountdown,
	thinnestMargin,
	windowVerdict,
} from "../src/hub/usage/insights";

function aggregate(overrides: Partial<UsageAggregate> = {}): UsageAggregate {
	return {
		totalRequests: 100,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: 0,
		cacheSavings: 0,
		totalCost: 10,
		unpricedRequests: 0,
		avgDuration: null,
		avgTtft: null,
		avgTokensPerSecond: null,
		lastTimestamp: 0,
		...overrides,
	};
}

function modelRow(overrides: Partial<UsageModelStats> = {}): UsageModelStats {
	return { model: "m", provider: "p", ...aggregate(), ...overrides };
}

function insight(overrides: Partial<UsageWindowInsight> = {}): UsageWindowInsight {
	return {
		provider: "zai",
		windowKey: "zai:5h",
		windowLabel: "5h limit",
		accounts: 1,
		cycles: 10,
		fractionConsumed: 3.2,
		estTokensPerWindow: 4_000_000,
		peakConcurrentFraction: 1.8,
		idealAccounts: 2,
		exhaustedEvents: 5,
		...overrides,
	};
}

describe("normalizeFraction", () => {
	test("passes 0–1 fractions through and clamps negatives", () => {
		expect(normalizeFraction(0.06)).toBe(0.06);
		expect(normalizeFraction(1)).toBe(1);
		expect(normalizeFraction(-0.2)).toBe(0);
	});

	test("treats values above 1.5 as percent scale", () => {
		expect(normalizeFraction(56)).toBe(0.56);
		expect(normalizeFraction(100)).toBe(1);
	});

	test("null/undefined/non-finite read as missing", () => {
		expect(normalizeFraction(null)).toBeNull();
		expect(normalizeFraction(undefined)).toBeNull();
		expect(normalizeFraction(Number.NaN)).toBeNull();
	});
});

describe("limitFraction", () => {
	test("prefers usedFraction", () => {
		const limit = { amount: { unit: "tokens", usedFraction: 0.72 } } as SubscriptionLimit;
		expect(limitFraction(limit)).toBe(0.72);
	});

	test("derives from used/limit and remaining/cap", () => {
		const used = { amount: { unit: "requests", used: 260, limit: 4000 } } as SubscriptionLimit;
		expect(limitFraction(used)).toBeCloseTo(0.065);
		const remaining = { amount: { unit: "requests", remaining: 750, limit: 1000 } } as SubscriptionLimit;
		expect(limitFraction(remaining)).toBeCloseTo(0.25);
	});

	test("falls back to remainingFraction complement", () => {
		const limit = { amount: { unit: "tokens", remainingFraction: 0.94 } } as SubscriptionLimit;
		expect(limitFraction(limit)).toBeCloseTo(0.06);
	});
});

describe("deriveHealth", () => {
	test("nominal range: ok verdict, no noise chips", () => {
		const health = deriveHealth({ overall: aggregate(), byModel: [], hourly: [] });
		expect(health.verdict).toEqual({ tone: "ok", text: "everything nominal" });
		expect(health.chips).toEqual([]);
	});

	test("high error rate escalates and warns the verdict", () => {
		const health = deriveHealth({ overall: aggregate({ failedRequests: 5, errorRate: 0.05 }), byModel: [], hourly: [] });
		expect(health.chips[0]?.tone).toBe("warn");
		expect(health.verdict.tone).toBe("warn");
		expect(health.verdict.text).toBe("1 thing to look at");
	});

	test("slow model with enough sample earns a ttft chip", () => {
		const health = deriveHealth({
			overall: aggregate(),
			byModel: [modelRow({ model: "k3", avgTtft: 16_600, totalRequests: 20 })],
			hourly: [],
		});
		expect(health.chips.some(chip => chip.tone === "warn" && chip.label.includes("k3"))).toBe(true);
	});

	test("tiny-sample slow model is ignored", () => {
		const health = deriveHealth({
			overall: aggregate(),
			byModel: [modelRow({ avgTtft: 60_000, totalRequests: 2 })],
			hourly: [],
		});
		expect(health.chips.some(chip => chip.label.includes("ttft"))).toBe(false);
	});

	test("unpriced requests surface as an info chip", () => {
		const health = deriveHealth({ overall: aggregate({ unpricedRequests: 12 }), byModel: [], hourly: [] });
		expect(health.chips.some(chip => chip.label === "12 unpriced")).toBe(true);
	});
});

describe("peakBurnWindow", () => {
	function hourly(cells: readonly number[]): UsageProviderHourPoint[] {
		return cells.flatMap((totalTokens, hour) => (totalTokens > 0 ? [{ provider: "p", hour, totalTokens, outputTokens: 0, requests: 0 }] : []));
	}

	test("finds the 3-hour window with the largest share", () => {
		const cells = new Array(24).fill(0);
		cells[21] = 30;
		cells[22] = 30;
		cells[23] = 30;
		cells[12] = 10;
		const peak = peakBurnWindow(hourly(cells));
		expect(peak?.label).toBe("21:00–00:00");
		expect(peak?.share).toBeCloseTo(0.9);
	});

	test("null without burn data", () => {
		expect(peakBurnWindow([])).toBeNull();
	});
});

describe("deriveCallouts", () => {
	test("capacity callout quotes idealAccounts verbatim", () => {
		const callouts = deriveCallouts([insight({ exhaustedEvents: 5, accounts: 1, idealAccounts: 2 })]);
		expect(callouts).toHaveLength(1);
		expect(callouts[0]?.tone).toBe("warn");
		expect(callouts[0]?.text).toContain("needs 2 accounts, fleet has 1 account");
	});

	test("no callout below the exhaustion guard", () => {
		expect(deriveCallouts([insight({ exhaustedEvents: 2, accounts: 1, idealAccounts: 2 })])).toHaveLength(0);
	});

	test("over-provisioned fleet is phrased as fleet-scale", () => {
		const callouts = deriveCallouts([
			insight({ accounts: 510, idealAccounts: 63, exhaustedEvents: 0, fractionConsumed: 6.6, provider: "kimi-code", windowLabel: "7d limit" }),
		]);
		expect(callouts).toHaveLength(1);
		expect(callouts[0]?.tone).toBe("info");
		expect(callouts[0]?.text).toContain("510 accounts (broker fleet)");
		expect(callouts[0]?.text).toContain("needs 63");
	});
});

describe("fleetQuotaCounts", () => {
	test("counts limits by fraction state and dedupes unreachable accounts", () => {
		const usage: SubscriptionUsage = {
			fetchedAt: 0,
			reports: [
				{
					provider: "zai",
					account: "a",
					fetchedAt: 0,
					limits: [
						{ id: "1", label: "L1", amount: { unit: "tokens", usedFraction: 0.1 } },
						{ id: "2", label: "L2", amount: { unit: "tokens", usedFraction: 0.8 } },
						{ id: "3", label: "L3", amount: { unit: "tokens", usedFraction: 1 } },
					],
				},
			],
			unavailable: [
				{ provider: "opencode-go", account: "API key" },
				{ provider: "opencode-go", account: "API key" },
			],
		};
		const counts = fleetQuotaCounts(usage);
		expect(counts).toEqual({ ok: 1, warn: 1, exhausted: 1, unreachable: 1 });
	});
});

describe("thinnestMargin + windowVerdict", () => {
	test("picks the most negative margin", () => {
		const thin = thinnestMargin([
			insight({ windowKey: "a", accounts: 2, idealAccounts: 3 }),
			insight({ windowKey: "b", accounts: 1, idealAccounts: 4 }),
		]);
		expect(thin?.windowKey).toBe("b");
	});

	test("null when every window has headroom", () => {
		expect(thinnestMargin([insight({ accounts: 5, idealAccounts: 1 })])).toBeNull();
	});

	test("verdict buckets: short, at capacity, headroom", () => {
		expect(windowVerdict(insight({ accounts: 1, idealAccounts: 2 })).text).toBe("short 1");
		expect(windowVerdict(insight({ accounts: 2, idealAccounts: 2 })).text).toBe("at capacity");
		expect(windowVerdict(insight({ accounts: 4, idealAccounts: 2 })).text).toBe("2× headroom");
	});
});

describe("errorKind", () => {
	test("classifies common failure vocabularies", () => {
		expect(errorKind("Your authentication token has expired")).toBe("auth");
		expect(errorKind('The socket connection was closed unexpectedly. pass `verbose: true`')).toBe("socket");
		expect(errorKind("429 Too Many Requests")).toBe("rate");
		expect(errorKind("Request timed out after 30s")).toBe("timeout");
		expect(errorKind("something else")).toBe("error");
	});
});

describe("resetCountdown", () => {
	const now = 1_000_000_000_000;
	test("formats minutes, hours, and days", () => {
		expect(resetCountdown(now + 5 * 60_000, now)).toBe("5m");
		expect(resetCountdown(now + 73 * 60_000, now)).toBe("1h 13m");
		expect(resetCountdown(now + 50 * 3_600_000, now)).toBe("2d 2h");
	});

	test("past resets read as past", () => {
		expect(resetCountdown(now - 1, now)).toBe("past");
	});
});
