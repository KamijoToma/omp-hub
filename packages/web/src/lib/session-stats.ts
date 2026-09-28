/**
 * Session-level usage aggregates for the customizable stats bar, folded from
 * the transcript's assistant messages on the client — no host round-trip, so
 * the numbers track exactly what the guest has seen land (plus the streaming
 * ghost, which is the only copy of the in-flight message at any snapshot).
 *
 * Formulas mirror the TUI status line's usage segments (oh-my-pi
 * `status-line/segments.ts`):
 * - cumulative tokens = Σ(input + output + cacheWrite), excluding cacheRead —
 *   that field re-reads the whole cached context every turn, so including it
 *   would grow the total by N×context_size;
 * - cache hit rate = cacheRead / (cacheRead + cacheWrite + input) — counting
 *   uncached input in the denominator keeps DeepSeek-style misses (reported as
 *   plain input) honest alongside Anthropic-style ones (cacheWrite > 0).
 *
 * Pure — no React, no DOM — so the bar and its tests agree on every number.
 */
import type { AssistantMessage, SessionEntry } from "./wire";

/** Aggregated usage over every usage-bearing assistant message. */
export interface SessionStats {
	/** Assistant messages that carried a usage block (including the live ghost). */
	requests: number;
	/** Uncached prompt tokens. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** TUI `token_total`: Σ(input + output + cacheWrite); cache reads excluded. */
	totalTokens: number;
	/** Σ estimated message cost, USD. */
	cost: number;
	/** Host-reported request timings, ms. `null` when the host never reported. */
	ttftLastMs: number | null;
	ttftAvgMs: number | null;
	/** Σ request wall time, ms — how long the model was working, not idle time. */
	requestMs: number;
	/** Σ output / Σ duration over requests past the sanity gate; `null` when none qualify. */
	tokensPerSec: number | null;
	/** 0–100 over the session's prompt tokens; `null` with no prompt tokens at all. */
	cacheHitRate: number | null;
	/**
	 * The latest request read zero cached tokens after the cache had been warm —
	 * the "cache went cold" signal. A session's first requests miss by
	 * definition, so they never set this.
	 */
	lastCacheMiss: boolean;
}

/** Finite number only: wire values are untrusted, absent/NaN reads as missing. */
function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). Same gate as the TUI usage row and `lib/usage.ts`. */
const MIN_RATE_DURATION_MS = 100;

class StatsFolder {
	requests = 0;
	inputTokens = 0;
	outputTokens = 0;
	cacheReadTokens = 0;
	cacheWriteTokens = 0;
	cost = 0;
	requestMs = 0;
	rateOutput = 0;
	rateMs = 0;
	#ttfts: number[] = [];
	#lastHadUsage = false;
	#lastInput = 0;
	#lastCacheRead = 0;
	#sawWarmCache = false;
	#lastMiss = false;

	message(message: AssistantMessage): void {
		const usage = message.usage;
		if (usage === null || typeof usage !== "object") return;
		const input = finite(usage.input);
		const output = finite(usage.output);
		const cacheRead = finite(usage.cacheRead);
		const cacheWrite = finite(usage.cacheWrite);
		this.requests += 1;
		this.inputTokens += input;
		this.outputTokens += output;
		this.cacheReadTokens += cacheRead;
		this.cacheWriteTokens += cacheWrite;
		this.cost += finite(usage.cost?.total);
		const duration = finite(message.duration);
		this.requestMs += duration;
		if (output > 0 && duration >= MIN_RATE_DURATION_MS) {
			this.rateOutput += output;
			this.rateMs += duration;
		}
		const ttft = finite(message.ttft);
		if (ttft > 0) this.#ttfts.push(ttft);

		// Cold-cache marker: a zero-read request only counts once the cache has
		// been warm; before that, misses are just the session warming up.
		this.#lastInput = input;
		this.#lastCacheRead = cacheRead;
		if (cacheRead > 0) this.#sawWarmCache = true;
		this.#lastHadUsage = true;
		this.#lastMiss = this.#sawWarmCache && cacheRead === 0 && (input > 0 || cacheWrite > 0);
	}

	fold(): SessionStats | null {
		if (this.requests === 0) return null;
		const ttftAvg =
			this.#ttfts.length > 0 ? this.#ttfts.reduce((sum, ms) => sum + ms, 0) / this.#ttfts.length : null;
		return {
			requests: this.requests,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			totalTokens: this.inputTokens + this.outputTokens + this.cacheWriteTokens,
			cost: this.cost,
			ttftLastMs: this.#ttfts.length > 0 ? (this.#ttfts[this.#ttfts.length - 1] ?? null) : null,
			ttftAvgMs: ttftAvg,
			requestMs: this.requestMs,
			tokensPerSec: this.rateMs >= MIN_RATE_DURATION_MS ? (this.rateOutput / this.rateMs) * 1000 : null,
			cacheHitRate:
				this.inputTokens + this.cacheWriteTokens + this.cacheReadTokens > 0
					? (this.cacheReadTokens / (this.inputTokens + this.cacheWriteTokens + this.cacheReadTokens)) * 100
					: null,
			lastCacheMiss: this.#lastHadUsage && this.#lastMiss,
		};
	}
}

/**
 * Aggregate every usage-bearing assistant message in `entries`, optionally
 * folding the streaming ghost (the accumulating in-flight message — the only
 * copy of it at any snapshot, so nothing double counts). `null` before the
 * first usage block: the bar renders nothing rather than zeros.
 */
export function sessionStats(
	entries: readonly SessionEntry[],
	stream?: AssistantMessage | null,
): SessionStats | null {
	const folder = new StatsFolder();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		folder.message(entry.message);
	}
	if (stream) folder.message(stream);
	return folder.fold();
}
