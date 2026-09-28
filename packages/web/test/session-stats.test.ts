/**
 * `sessionStats` — the client-side aggregation behind the stats bar. Easy to
 * regress: the cumulative total must exclude cache reads (TUI parity — they
 * re-read the whole context every turn), the cache-miss marker must stay quiet
 * while the session warms up, and the streaming ghost must fold in without
 * ever double counting the message that later lands as an entry.
 */
import { describe, expect, test } from "bun:test";
import { sessionStats } from "../src/lib/session-stats";
import type { AssistantMessage, SessionEntry, WireUsage } from "../src/lib/wire";

function usage(overrides: Partial<WireUsage> = {}): WireUsage {
	return {
		input: 100,
		output: 50,
		cacheRead: 1000,
		cacheWrite: 20,
		totalTokens: 1170,
		cost: { total: 0.01 },
		...overrides,
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function messageEntry(message: AssistantMessage): SessionEntry {
	return { type: "message", id: `e${message.timestamp}`, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message };
}

describe("sessionStats", () => {
	test("returns null before the first usage block instead of zeros", () => {
		expect(sessionStats([])).toBeNull();
		const userOnly: SessionEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hi", timestamp: Date.now() },
		};
		expect(sessionStats([userOnly])).toBeNull();
	});

	test("aggregates tokens excluding cache reads, TUI parity", () => {
		const stats = sessionStats([messageEntry(assistant())]);
		expect(stats).not.toBeNull();
		// input 100 + output 50 + cacheWrite 20; cacheRead 1000 excluded.
		expect(stats!.totalTokens).toBe(170);
		expect(stats!.inputTokens).toBe(100);
		expect(stats!.outputTokens).toBe(50);
		expect(stats!.cacheReadTokens).toBe(1000);
		expect(stats!.cacheWriteTokens).toBe(20);
		expect(stats!.requests).toBe(1);
		expect(stats!.cost).toBeCloseTo(0.01);
	});

	test("sums cost and tokens across messages", () => {
		const entries = [
			messageEntry(assistant({ timestamp: 1 })),
			messageEntry(assistant({ timestamp: 2, usage: usage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } }) })),
		];
		const stats = sessionStats(entries)!;
		expect(stats.requests).toBe(2);
		expect(stats.inputTokens).toBe(110);
		expect(stats.outputTokens).toBe(55);
		expect(stats.cost).toBeCloseTo(0.012);
	});

	test("cache hit rate counts uncached input and cache writes in the denominator", () => {
		const stats = sessionStats([messageEntry(assistant())])!;
		// 1000 / (100 + 20 + 1000)
		expect(stats.cacheHitRate).toBeCloseTo((1000 / 1120) * 100);
	});

	test("cache hit rate is null when the provider reports no prompt tokens", () => {
		const stats = sessionStats([messageEntry(assistant({ usage: usage({ input: 0, cacheRead: 0, cacheWrite: 0 }) }))])!;
		expect(stats.cacheHitRate).toBeNull();
	});

	test("first-request misses do not set the cold-cache marker", () => {
		const stats = sessionStats([messageEntry(assistant({ usage: usage({ cacheRead: 0 }) }))])!;
		expect(stats.lastCacheMiss).toBe(false);
	});

	test("a zero-read request after a warm cache marks the miss", () => {
		const entries = [
			messageEntry(assistant({ timestamp: 1 })),
			messageEntry(assistant({ timestamp: 2, usage: usage({ cacheRead: 0 }) })),
		];
		const stats = sessionStats(entries)!;
		expect(stats.lastCacheMiss).toBe(true);
		// Hit rate still aggregates across both requests.
		expect(stats.cacheHitRate).toBeCloseTo((1000 / (120 + 1120)) * 100);
	});

	test("a zero-read request with no prompt tokens is not a miss", () => {
		const entries = [
			messageEntry(assistant({ timestamp: 1 })),
			messageEntry(assistant({ timestamp: 2, usage: usage({ cacheRead: 0, input: 0, cacheWrite: 0 }) })),
		];
		expect(sessionStats(entries)!.lastCacheMiss).toBe(false);
	});

	test("folds ttft last and average", () => {
		const entries = [
			messageEntry(assistant({ timestamp: 1, ttft: 500 })),
			messageEntry(assistant({ timestamp: 2, ttft: 1500 })),
		];
		const stats = sessionStats(entries)!;
		expect(stats.ttftLastMs).toBe(1500);
		expect(stats.ttftAvgMs).toBe(1000);
	});

	test("ttft is null when the host never reported timing", () => {
		const stats = sessionStats([messageEntry(assistant())])!;
		expect(stats.ttftLastMs).toBeNull();
		expect(stats.ttftAvgMs).toBeNull();
	});

	test("rate sums gated requests and stays null below the sanity gate", () => {
		const gated = (output: number, duration: number): AssistantMessage =>
			assistant({ timestamp: duration, duration, usage: usage({ output }) });
		const stats = sessionStats([messageEntry(gated(100, 1000)), messageEntry(gated(300, 3000))])!;
		expect(stats.tokensPerSec).toBeCloseTo(100);
		expect(stats.requestMs).toBe(4000);

		const tooFast = sessionStats([messageEntry(assistant({ duration: 50, usage: usage({ output: 50 }) }))])!;
		expect(tooFast.tokensPerSec).toBeNull();
	});

	test("folds the streaming ghost without double counting the landed entry", () => {
		const landed = assistant({ timestamp: 1 });
		const entries = [messageEntry(landed)];
		// Mid-stream: the ghost is the only copy of the in-flight message.
		const ghost = assistant({ timestamp: 2, usage: usage({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.003 } }) });
		const midStream = sessionStats(entries, ghost)!;
		expect(midStream.requests).toBe(2);
		expect(midStream.inputTokens).toBe(300);

		// After message_end the entry lands and the ghost is dropped — same
		// message never counted twice in any snapshot.
		const finalStats = sessionStats([...entries, messageEntry(ghost)])!;
		expect(finalStats.requests).toBe(2);
		expect(finalStats.inputTokens).toBe(300);
	});

	test("tolerates untrusted wire values: non-finite numbers read as missing", () => {
		const bogus = {
			...assistant(),
			usage: { input: Number.NaN, output: "50", cacheRead: undefined, cacheWrite: null, totalTokens: 1e309, cost: { total: Number.POSITIVE_INFINITY } },
		} as unknown as AssistantMessage;
		const stats = sessionStats([messageEntry(bogus)])!;
		expect(stats.totalTokens).toBe(0);
		expect(stats.cost).toBe(0);
		expect(stats.requests).toBe(1);
	});

	test("ignores non-assistant and non-message entries", () => {
		const mixed: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hi", timestamp: Date.now() },
			},
			{ type: "compaction", id: "e2", parentId: null, timestamp: new Date().toISOString(), summary: "s", firstKeptEntryId: "e1", tokensBefore: 5000 },
		];
		expect(sessionStats(mixed)).toBeNull();
	});
});
