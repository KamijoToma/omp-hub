/**
 * Token-usage and context-window helpers shared by the transcript's per-message
 * usage rows and the hub's context dialog. Pure — no React, no DOM — so both
 * surfaces agree on how a metric the host never reported renders (`null`, shown
 * as "—") versus a real zero.
 */
import type { AssistantMessage, WireUsage } from "./wire";

/** Finite number or `null`: `0` is a value, absent/`NaN` is not. */
function metric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One message's usage, each metric as `number | null` (`null` = unreported). */
export interface UsageDetail {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	totalTokens: number | null;
	cost: number | null;
	ttftMs: number | null;
	durationMs: number | null;
}

/** Message-level request timing fields the host may report alongside usage. */
type MessageTiming = Pick<AssistantMessage, "ttft" | "duration">;

/**
 * Normalise a wire usage block plus the message's optional request timing.
 * `null` when the message carried neither, or when every metric is missing —
 * a block with nothing in it says no more than no block at all.
 */
export function usageDetail(
	usage: WireUsage | null | undefined,
	timing?: MessageTiming | undefined,
): UsageDetail | null {
	if (usage === null || usage === undefined || typeof usage !== "object") return null;
	const detail: UsageDetail = {
		input: metric(usage.input),
		output: metric(usage.output),
		cacheRead: metric(usage.cacheRead),
		cacheWrite: metric(usage.cacheWrite),
		totalTokens: metric(usage.totalTokens),
		cost: metric(usage.cost?.total),
		ttftMs: metric(timing?.ttft),
		durationMs: metric(timing?.duration),
	};
	return Object.values(detail).some(value => value !== null) ? detail : null;
}

/** Below this the rate is nonsense — cached/instant responses yield absurd tok/s. Same gate as the TUI usage row. */
const MIN_RATE_DURATION_MS = 100;

/**
 * Output tok/s over the whole request window. Deliberately not the post-TTFT
 * decode window: reasoning tokens hidden before the first visible byte make
 * that window lie. `null` when unreported or beneath the sanity gate.
 */
export function outputTokensPerSecond(detail: UsageDetail): number | null {
	if (detail.output === null || detail.durationMs === null) return null;
	if (detail.output <= 0 || detail.durationMs <= MIN_RATE_DURATION_MS) return null;
	return (detail.output / detail.durationMs) * 1000;
}

/**
 * USD for one message's usage; the caller marks it as a price-table estimate.
 * Precision scales with magnitude so a small-but-real cost never collapses to
 * "$0.000" the way `fmtCost`'s three-decimal floor would print it.
 */
export function fmtUsageCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	if (usd >= 0.001) return `$${usd.toFixed(3)}`;
	const text = usd.toFixed(6).replace(/0+$/, "");
	// Below a micro-dollar even six decimals round away: say "less than".
	return text === "0." ? "<$0.000001" : `$${text}`;
}

/**
 * Percent of the configured window in use; `null` when either side is unknown
 * or the window is not a positive number (no model selected).
 */
export function contextPercent(usedTokens: number | null, contextWindow: number | null): number | null {
	const used = metric(usedTokens);
	const window = metric(contextWindow);
	if (used === null || window === null || window <= 0) return null;
	return (used / window) * 100;
}
