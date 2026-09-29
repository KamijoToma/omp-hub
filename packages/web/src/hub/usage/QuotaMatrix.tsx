/**
 * The quota matrix: provider-grouped accounts × limit windows. Each cell is
 * a status-colored fraction bar (remaining *length* reads preattentively),
 * the percent, and a T-minus countdown — replacing the old donut-free
 * text-wall with an aligned grid that scales to any account count.
 * Unreachable accounts collapse into one deduped gray row.
 */
import type { ReactNode } from "react";
import type { SubscriptionLimit, SubscriptionReport, SubscriptionUsage } from "../api";
import { limitFraction, resetCountdown } from "./insights";
import { useNow } from "./use-now";

function cellTone(fraction: number | null, status: string | undefined): "ok" | "warn" | "err" {
	if (status === "exhausted" || (fraction !== null && fraction >= 1)) return "err";
	if (fraction !== null && fraction >= 0.7) return "warn";
	return "ok";
}

function QuotaCell({ limit, now }: { limit: SubscriptionLimit; now: number }): ReactNode {
	const fraction = limitFraction(limit);
	const tone = cellTone(fraction, limit.status);
	const resetsAt = limit.window?.resetsAt;
	const amount = [
		limit.amount.used !== undefined && limit.amount.limit !== undefined ? `${limit.amount.used} / ${limit.amount.limit} ${limit.amount.unit}` : undefined,
		limit.amount.remaining !== undefined ? `${limit.amount.remaining} left` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<span
			className={`hb-uz-qcell hb-uz-tone-${tone}`}
			title={`${limit.label}${amount ? ` — ${amount}` : ""}${limit.status ? ` (${limit.status})` : ""}`}
		>
			<span className="hb-uz-qcell-label">{limit.window?.label ?? limit.label}</span>
			<span className="hb-uz-qcell-bar" aria-hidden="true">
				<span style={{ width: `${Math.min((fraction ?? 0) * 100, 100)}%` }} />
			</span>
			<span className="hb-uz-qcell-meta">
				{fraction === null ? "no usage data" : `${Math.round(fraction * 100)}% used`}
				{resetsAt !== undefined && ` · T-${resetCountdown(resetsAt, now)}`}
			</span>
		</span>
	);
}

export function QuotaMatrix({ usage }: { usage: SubscriptionUsage }): ReactNode {
	const now = useNow();
	const providers = new Map<string, SubscriptionReport[]>();
	for (const report of usage.reports) {
		const bucket = providers.get(report.provider);
		if (bucket) bucket.push(report);
		else providers.set(report.provider, [report]);
	}
	const unavailable = [...new Set(usage.unavailable.map(account => `${account.provider}\u0000${account.account}`))];

	if (providers.size === 0 && unavailable.length === 0) {
		return <p className="hb-uz-empty">no quota-tracked accounts for this profile</p>;
	}

	return (
		<div className="hb-uz-qmatrix">
			{[...providers.entries()].map(([provider, reports]) => (
				<section className="hb-uz-qgroup" key={provider}>
					<h3 className="hb-uz-qgroup-head">{provider}</h3>
					{reports.map(report => (
						<div className="hb-uz-qaccount" key={`${report.provider}:${report.account}`}>
							<span className="hb-uz-qaccount-name">{report.account}</span>
							<span className="hb-uz-qaccount-cells">
								{report.limits.map(limit => (
									<QuotaCell key={limit.id} limit={limit} now={now} />
								))}
							</span>
						</div>
					))}
				</section>
			))}
			{unavailable.length > 0 && (
				<p className="hb-uz-qunavailable">
					quota unavailable — {unavailable.map(key => key.replace("\u0000", " · ")).join("; ")}
				</p>
			)}
		</div>
	);
}
