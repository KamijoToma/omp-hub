/**
 * Subscriptions-tab opener: the whole fleet's quota state in one line
 * (ok/warn/exhausted/unreachable counts, next reset, thinnest margin) plus
 * the guarded action callouts. Everything derives from pure helpers in
 * usage/insights.ts — this file only formats.
 */
import type { ReactNode } from "react";
import type { SubscriptionUsage, UsageWindowInsight } from "../api";
import { deriveCallouts, fleetQuotaCounts, resetCountdown, thinnestMargin } from "./insights";
import { useNow } from "./use-now";

export function FleetStrip({ usage, insights }: { usage: SubscriptionUsage; insights: readonly UsageWindowInsight[] }): ReactNode {
	const counts = fleetQuotaCounts(usage);
	const now = useNow();
	const resets = usage.reports
		.flatMap(report => report.limits.map(limit => ({ provider: report.provider, label: limit.label, resetsAt: limit.window?.resetsAt })))
		.filter(reset => reset.resetsAt !== undefined)
		.sort((a, b) => a.resetsAt! - b.resetsAt!);
	const next = resets[0];
	const thin = thinnestMargin(insights);

	return (
		<div className="hb-uz-fleet" role="status">
			<span className="hb-uz-fleet-counts">
				<span className="hb-uz-tone-ok">{counts.ok} ok</span>
				<span className="hb-uz-sep">·</span>
				<span className={counts.warn > 0 ? "hb-uz-tone-warn" : undefined}>{counts.warn} warn</span>
				<span className="hb-uz-sep">·</span>
				<span className={counts.exhausted > 0 ? "hb-uz-tone-err" : undefined}>{counts.exhausted} exhausted</span>
				<span className="hb-uz-sep">·</span>
				<span>{counts.unreachable} unreachable</span>
			</span>
			{next?.resetsAt !== undefined && (
				<span className="hb-uz-chip" title={`${next.provider} · ${next.label}`}>
					next reset {resetCountdown(next.resetsAt, now)} · {next.provider} · {next.label}
				</span>
			)}
			{thin && (
				<span className="hb-uz-chip hb-uz-tone-warn" title="window with the least headroom against peak demand">
					thinnest margin {thin.provider} {thin.windowLabel} · peak needs {thin.idealAccounts} accounts, has {thin.accounts}
				</span>
			)}
		</div>
	);
}

/** Actionable capacity findings; renders nothing when the guards see nothing. */
export function CalloutBar({ insights }: { insights: readonly UsageWindowInsight[] }): ReactNode {
	const callouts = deriveCallouts(insights);
	if (callouts.length === 0) return null;
	return (
		<div className="hb-uz-callouts" role="alert">
			{callouts.map(callout => (
				<p key={callout.id} className={`hb-uz-callout ${callout.tone === "warn" ? "hb-uz-tone-warn" : "hb-uz-tone-info"}`}>
					{callout.text}
				</p>
			))}
		</div>
	);
}
