/**
 * Pure derivations for the usage page's glanceable layers — health verdict,
 * quota callouts, fleet counts, window verdicts. No React, no DOM: every
 * number here is unit-testable and the components only format what these
 * functions decide.
 *
 * Honesty rules encoded here (docs/protocol.md §3 usage relay):
 * - callout math uses the dashboard's own `idealAccounts` verbatim — never
 *   per-UI arithmetic that can disagree with the API;
 * - fleet-scale account counts are phrased as fleet-wide, never headlined as
 *   this machine's own;
 * - fractions arrive in provider-specific scales (`unit: "percent"` vs 0–1)
 *   and are normalized exactly once, here.
 */
import type {
	SubscriptionLimit,
	SubscriptionUsage,
	UsageAggregate,
	UsageModelStats,
	UsageProviderHourPoint,
	UsageWindowInsight,
} from "../api";

/** Visual severity shared by chips, verdicts, and callouts. */
export type Tone = "ok" | "info" | "warn" | "err";

/** One glanceable fact on the health strip. */
export interface HealthChip {
	tone: Tone;
	/** Short chip label, e.g. `26 failed`. */
	label: string;
	/** Longer explanation for the tooltip; omitted when the label says it all. */
	detail?: string;
}

/** Thresholds for the TTFT chip: warn the operator, ignore tiny samples. */
const TTFT_WARN_MS = 10_000;
const TTFT_MIN_SAMPLE = 5;
/** A contiguous hour window holding this share of burn earns a chip. */
const PEAK_WINDOW_SHARE = 0.35;
/** A request-failure rate above this is a warn, above `ERR` an error. */
const ERROR_RATE_WARN = 0.02;
const ERROR_RATE_ERR = 0.08;
/** Quota fractions past this point count as "warn" in the fleet strip. */
const QUOTA_WARN_FRACTION = 0.7;

/**
 * Normalizes a provider-reported used fraction to 0–1. `unit: "percent"`
 * payloads and fractions above 1.5 are treated as percent scale; anything in
 * between is genuine overage (>1 = the window was exceeded) and stays.
 */
export function normalizeFraction(value: number | null | undefined): number | null {
	if (value === null || value === undefined || !Number.isFinite(value)) return null;
	if (value > 1.5) return value / 100;
	return Math.max(0, value);
}

/** The filled share of one quota window, from whichever fields the provider reported. */
export function limitFraction(limit: SubscriptionLimit): number | null {
	const direct = normalizeFraction(limit.amount.usedFraction);
	if (direct !== null) return direct;
	const { used, limit: cap, remaining, remainingFraction } = limit.amount;
	if (used !== undefined && cap !== undefined && cap > 0) return normalizeFraction(used / cap);
	if (remaining !== undefined && cap !== undefined && cap > 0) return normalizeFraction(1 - remaining / cap);
	const rest = normalizeFraction(remainingFraction);
	return rest === null ? null : normalizeFraction(1 - rest);
}

/**
 * The health strip: a one-line verdict plus the facts behind it. Chips are
 * ordered worst-tone-first so the strip reads as triage.
 */
export function deriveHealth(input: {
	overall: UsageAggregate;
	byModel: readonly UsageModelStats[];
	hourly: readonly UsageProviderHourPoint[];
}): { verdict: { tone: Tone; text: string }; chips: HealthChip[] } {
	const chips: HealthChip[] = [];
	const { overall, byModel, hourly } = input;

	if (overall.failedRequests > 0) {
		const rate = overall.totalRequests > 0 ? overall.failedRequests / overall.totalRequests : 0;
		chips.push({
			tone: rate >= ERROR_RATE_ERR ? "err" : rate >= ERROR_RATE_WARN ? "warn" : "ok",
			label: `${overall.failedRequests} failed`,
			detail: `${(rate * 100).toFixed(1)}% error rate`,
		});
	}

	const slowest = byModel
		.filter(row => row.avgTtft !== null && row.totalRequests >= TTFT_MIN_SAMPLE)
		.sort((a, b) => (b.avgTtft ?? 0) - (a.avgTtft ?? 0))[0];
	if (slowest?.avgTtft !== null && slowest?.avgTtft !== undefined && slowest.avgTtft >= TTFT_WARN_MS) {
		chips.push({
			tone: "warn",
			label: `${slowest.model} ttft ${Math.round(slowest.avgTtft / 1000)}s`,
			detail: "slowest model in range (≥5 request sample)",
		});
	}

	const peak = peakBurnWindow(hourly);
	if (peak !== null && peak.share >= PEAK_WINDOW_SHARE) {
		chips.push({
			tone: peak.share >= 0.5 ? "warn" : "info",
			label: `${Math.round(peak.share * 100)}% of burn ${peak.label}`,
			detail: "hour-of-day concentration; schedule window resets ahead of it",
		});
	}

	if (overall.unpricedRequests > 0) {
		chips.push({
			tone: "info",
			label: `${overall.unpricedRequests} unpriced`,
			detail: "subscription-backed requests without a public-equivalent price",
		});
	}

	const trouble = chips.filter(chip => chip.tone === "warn" || chip.tone === "err").length;
	return {
		verdict: trouble > 0 ? { tone: trouble >= 2 ? "err" : "warn", text: `${trouble} thing${trouble === 1 ? "" : "s"} to look at` } : { tone: "ok", text: "everything nominal" },
		chips,
	};
}

/**
 * Contiguous 3-hour window with the largest share of token burn, or null when
 * there is no burn data. Window labels wrap midnight (22:00–01:00).
 */
export function peakBurnWindow(hourly: readonly UsageProviderHourPoint[]): { label: string; share: number } | null {
	const perHour = new Array<number>(24).fill(0);
	let total = 0;
	for (const point of hourly) {
		perHour[point.hour] += point.totalTokens;
		total += point.totalTokens;
	}
	if (total <= 0) return null;
	let best = 0;
	let bestHour = 0;
	for (let start = 0; start < 24; start++) {
		let window = 0;
		for (let offset = 0; offset < 3; offset++) window += perHour[(start + offset) % 24];
		if (window > best) {
			best = window;
			bestHour = start;
		}
	}
	const share = best / total;
	const endHour = (bestHour + 3) % 24;
	return { label: `${String(bestHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00`, share };
}

/** One guarded, actionable suggestion above the quota matrix. */
export interface UsageCallout {
	id: string;
	tone: "warn" | "info";
	text: string;
}

/**
 * Capacity callouts from the dashboard's own window insights. Deliberately
 * conservative: only speak when the signal is unambiguous (repeated
 * exhaustions, or a fleet an order of magnitude larger than peak demand
 * needs), and always quote `idealAccounts` instead of derived arithmetic.
 */
export function deriveCallouts(insights: readonly UsageWindowInsight[]): UsageCallout[] {
	const callouts: UsageCallout[] = [];
	for (const insight of insights) {
		const scale = insight.accounts >= 20 ? `${insight.accounts} accounts (broker fleet)` : `${insight.accounts} account${insight.accounts === 1 ? "" : "s"}`;
		if (insight.exhaustedEvents >= 3 && insight.accounts < insight.idealAccounts) {
			callouts.push({
				id: `capacity:${insight.windowKey}`,
				tone: "warn",
				text: `Add capacity: ${insight.provider} ${insight.windowLabel} ran dry ${insight.exhaustedEvents}× — peak demand needs ${insight.idealAccounts} accounts, fleet has ${scale}`,
			});
		} else if (insight.accounts >= 20 && insight.accounts >= 8 * Math.max(insight.idealAccounts, 1) && insight.fractionConsumed > 0.5) {
			callouts.push({
				id: `surplus:${insight.windowKey}`,
				tone: "info",
				text: `Over-provisioned: ${insight.provider} ${insight.windowLabel} — ${scale} where peak demand needs ${insight.idealAccounts}`,
			});
		}
	}
	return callouts.slice(0, 3);
}

/** Per-limit tallies for the fleet strip; `unreachable` counts deduped accounts. */
export function fleetQuotaCounts(usage: SubscriptionUsage): {
	ok: number;
	warn: number;
	exhausted: number;
	unreachable: number;
} {
	let ok = 0;
	let warn = 0;
	let exhausted = 0;
	for (const report of usage.reports) {
		for (const limit of report.limits) {
			const fraction = limitFraction(limit);
			if (limit.status === "exhausted" || (fraction !== null && fraction >= 1)) exhausted++;
			else if (fraction !== null && fraction >= QUOTA_WARN_FRACTION) warn++;
			else ok++;
		}
	}
	const unreachable = new Set(usage.unavailable.map(account => `${account.provider}\u0000${account.account}`)).size;
	return { ok, warn, exhausted, unreachable };
}

/**
 * The window closest to tipping over: enrolled accounts below what peak
 * demand needs, most negative margin first, exhaustions breaking ties.
 */
export function thinnestMargin(insights: readonly UsageWindowInsight[]): UsageWindowInsight | null {
	const short = insights.filter(insight => insight.accounts < insight.idealAccounts);
	if (short.length === 0) return null;
	return short.sort((a, b) => (b.idealAccounts - b.accounts) - (a.idealAccounts - a.accounts) || b.exhaustedEvents - a.exhaustedEvents)[0];
}

/** Capacity verdict for one window row: short / at capacity / headroom multiple. */
export function windowVerdict(insight: UsageWindowInsight): { tone: Tone; text: string } {
	if (insight.idealAccounts > insight.accounts) return { tone: "warn", text: `short ${insight.idealAccounts - insight.accounts}` };
	if (insight.idealAccounts === insight.accounts) return { tone: "info", text: "at capacity" };
	const multiple = insight.idealAccounts >= 1 ? Math.floor(insight.accounts / insight.idealAccounts) : insight.accounts;
	return { tone: "ok", text: `${multiple}× headroom` };
}

/** Buckets an error message into the badge the tail renders. */
export function errorKind(message: string | null): "auth" | "socket" | "rate" | "timeout" | "error" {
	const text = (message ?? "").toLowerCase();
	if (/429|too many requests|rate limit|quota/.test(text)) return "rate";
	if (/auth|unauthorized|401|403|token|api key/.test(text)) return "auth";
	if (/socket|closed unexpectedly|network|econn|fetch failed|connect/.test(text)) return "socket";
	if (/timed? ?out|timeout|deadline/.test(text)) return "timeout";
	return "error";
}

/** Countdown label for a reset timestamp: `1h 13m`, `4d 7h`, `past`. */
export function resetCountdown(resetsAt: number, now: number): string {
	const delta = resetsAt - now;
	if (!Number.isFinite(delta) || delta <= 0) return "past";
	const minutes = Math.round(delta / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
