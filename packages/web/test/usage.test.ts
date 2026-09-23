/**
 * Usage/context helpers behind the transcript's per-message usage rows and the
 * context dialog. Two behaviours are easy to regress: a metric the host never
 * reported must not read as a real zero, and a small-but-real cost must not be
 * rounded into "$0.000".
 */
import { describe, expect, test } from "bun:test";
import { contextPercent, fmtUsageCost, outputTokensPerSecond, usageDetail } from "../src/lib/usage";
import type { UsageDetail } from "../src/lib/usage";
import type { WireUsage } from "../src/lib/wire";

describe("usageDetail", () => {
	test("reports a message that carried no usage block as unavailable", () => {
		expect(usageDetail(undefined)).toBeNull();
		expect(usageDetail(null)).toBeNull();
	});

	test("keeps real zeros instead of collapsing them into unavailable", () => {
		const zeroed: WireUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { total: 0 },
		};

		expect(usageDetail(zeroed)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
			ttftMs: null,
			durationMs: null,
		});
	});

	test("marks only the absent metrics null", () => {
		const partial = { input: 120, output: 8, totalTokens: 128 } as Partial<WireUsage> as WireUsage;

		expect(usageDetail(partial)).toEqual({
			input: 120,
			output: 8,
			cacheRead: null,
			cacheWrite: null,
			totalTokens: 128,
			cost: null,
			ttftMs: null,
			durationMs: null,
		});
	});
});

describe("usageDetail timing", () => {
	const usage: WireUsage = {
		input: 120,
		output: 400,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 520,
		cost: { total: 0.01 },
	};

	test("attaches the message's host-reported request timing", () => {
		const detail = usageDetail(usage, { ttft: 832, duration: 2_140 });
		expect(detail?.ttftMs).toBe(832);
		expect(detail?.durationMs).toBe(2_140);
	});

	test("treats non-finite timing as unreported", () => {
		const detail = usageDetail(usage, { ttft: Number.NaN, duration: Number.POSITIVE_INFINITY });
		expect(detail?.ttftMs).toBeNull();
		expect(detail?.durationMs).toBeNull();
	});

	test("keeps a timing-only message instead of dropping it", () => {
		const detail = usageDetail({} as WireUsage, { ttft: 900, duration: 1_500 });
		expect(detail).toEqual({
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			totalTokens: null,
			cost: null,
			ttftMs: 900,
			durationMs: 1_500,
		});
	});
});

describe("outputTokensPerSecond", () => {
	const detail: UsageDetail = {
		input: 120,
		output: 400,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 520,
		cost: 0.01,
		ttftMs: 830,
		durationMs: 2_000,
	};

	test("rates output over the whole request window", () => {
		expect(outputTokensPerSecond(detail)).toBe(200);
	});

	test("is null below the 100ms sanity gate", () => {
		expect(outputTokensPerSecond({ ...detail, output: 5, durationMs: 50 })).toBeNull();
	});

	test("is null without reported output or duration", () => {
		expect(outputTokensPerSecond({ ...detail, output: null })).toBeNull();
		expect(outputTokensPerSecond({ ...detail, durationMs: null })).toBeNull();
	});
});

describe("fmtUsageCost", () => {
	test("keeps a small positive cost out of the $0.000 floor", () => {
		expect(fmtUsageCost(0.0002)).toBe("$0.0002");
		expect(fmtUsageCost(0.0042)).toBe("$0.004");
		expect(fmtUsageCost(12.3456)).toBe("$12.35");
	});

	test("prints an exact zero as zero and a sub-micro cost as a floor", () => {
		expect(fmtUsageCost(0)).toBe("$0.00");
		expect(fmtUsageCost(4e-7)).toBe("<$0.000001");
	});
});

describe("contextPercent", () => {
	test("computes the share of the configured window", () => {
		expect(contextPercent(50_000, 200_000)).toBe(25);
	});

	test("is null without usage or without a positive window", () => {
		expect(contextPercent(1_000, 0)).toBeNull();
		expect(contextPercent(1_000, null)).toBeNull();
		expect(contextPercent(null, 200_000)).toBeNull();
	});
});
