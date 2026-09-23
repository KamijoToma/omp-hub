/**
 * Token-usage and context-window helpers shared by the transcript's per-message
 * usage rows and the hub's context dialog. Pure — no React, no DOM — so both
 * surfaces agree on how a metric the host never reported renders (`null`, shown
 * as "—") versus a real zero.
 */
import type { WireUsage } from "./wire";

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
}

/**
 * Normalise a wire usage block. `null` when the message carried none, or when
 * every metric is missing — a block with nothing in it says no more than no
 * block at all.
 */
export function usageDetail(usage: WireUsage | null | undefined): UsageDetail | null {
	if (usage === null || usage === undefined || typeof usage !== "object") return null;
	const detail: UsageDetail = {
		input: metric(usage.input),
		output: metric(usage.output),
		cacheRead: metric(usage.cacheRead),
		cacheWrite: metric(usage.cacheWrite),
		totalTokens: metric(usage.totalTokens),
		cost: metric(usage.cost?.total),
	};
	return Object.values(detail).some(value => value !== null) ? detail : null;
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
