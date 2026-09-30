/**
 * Ordinal reset rail: upcoming quota resets as countdown chips in the order
 * the operator cares about (soonest first). A linear time axis wastes its
 * width on "later" — order plus countdown is the decision-relevant encoding.
 */
import type { ReactNode } from "react";
import type { SubscriptionUsage } from "../api";
import { resetCountdown } from "./insights";
import { useNow } from "./use-now";

const MAX_CHIPS = 8;

interface ResetChip {
	id: string;
	provider: string;
	label: string;
	resetsAt: number;
}

export function ResetRail({ usage }: { usage: SubscriptionUsage }): ReactNode {
	const now = useNow();
	const chips: ResetChip[] = usage.reports
		.flatMap(report =>
			report.limits
				.filter(limit => limit.window?.resetsAt !== undefined)
				.map(limit => ({
					id: `${report.provider}:${report.account}:${limit.id}`,
					provider: report.provider,
					label: limit.window?.label ?? limit.label,
					resetsAt: limit.window!.resetsAt!,
				})),
		)
		.sort((a, b) => a.resetsAt - b.resetsAt)
		.slice(0, MAX_CHIPS);

	if (chips.length === 0) return null;

	return (
		<div className="hb-uz-rail" aria-label="upcoming quota resets">
			{chips.map(chip => (
				<span key={chip.id} className="hb-uz-rail-chip" title={`${chip.provider} · ${chip.label}`}>
					<strong>T-{resetCountdown(chip.resetsAt, now)}</strong>
					<span>{chip.label}</span>
					<span className="hb-uz-rail-provider">{chip.provider}</span>
				</span>
			))}
		</div>
	);
}
