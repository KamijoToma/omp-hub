/**
 * The tab's pulse: latest requests beside the latest failures, 8 rows each.
 * A live feed, not a log viewer — anything longer belongs in the machine's
 * own dashboard. Agent-type badges surface only subagents/advisors; error
 * badges classify the message so recurring socket/auth/429 storms read at a
 * glance.
 */
import type { ReactNode } from "react";
import type { UsageRecentRequest } from "../api";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { errorKind } from "./insights";
import { hueClass } from "./use-now";

function clock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function tokensPerSecond(row: UsageRecentRequest): string | null {
	if (row.duration < 100 || row.usage.output <= 0) return null;
	return `${fmtTokens((row.usage.output / row.duration) * 1000)}/s`;
}

export function ActivityTail({
	recent,
	errors,
	hues,
}: {
	recent: readonly UsageRecentRequest[];
	errors: readonly UsageRecentRequest[];
	hues: ReadonlyMap<string, number>;
}): ReactNode {
	const hasEither = recent.length > 0 || errors.length > 0;
	if (!hasEither) return null;

	return (
		<div className="hb-uz-tail">
			{recent.length > 0 && (
				<section className="hb-uz-tail-col" aria-label="recent requests">
					<h3 className="hb-uz-tail-head">live tail</h3>
					<ul className="hb-uz-tail-list">
						{recent.map(row => {
							const rate = tokensPerSecond(row);
							return (
								<li key={row.id} className="hb-uz-tail-row">
									<span className="hb-uz-tail-time">{clock(row.timestamp)}</span>
									<span className={`hb-uz-swatch ${hueClass(hues.get(row.provider) ?? -1)}`} aria-hidden="true" />
									<span className="hb-uz-tail-model" title={`${row.provider}/${row.model}`}>
										{row.model}
									</span>
									{row.agentType !== "main" && <span className="hb-uz-badge">{row.agentType === "subagent" ? "SUB" : "ADV"}</span>}
									<span className="hb-uz-tail-metric">{rate ?? `${fmtTokens(row.usage.totalTokens)} tok`}</span>
									<span className="hb-uz-tail-metric">{row.ttft === null ? "—" : fmtDuration(row.ttft)}</span>
									<span className="hb-uz-tail-cost">{row.costUnpriced ? "sub" : fmtCost(row.usage.cost.total)}</span>
								</li>
							);
						})}
					</ul>
				</section>
			)}
			{errors.length > 0 && (
				<section className="hb-uz-tail-col" aria-label="recent errors">
					<h3 className="hb-uz-tail-head">errors</h3>
					<ul className="hb-uz-tail-list">
						{errors.map(row => {
							const kind = errorKind(row.errorMessage);
							return (
								<li key={row.id} className="hb-uz-tail-row hb-uz-tail-err">
									<span className="hb-uz-tail-time">{clock(row.timestamp)}</span>
									<span className={`hb-uz-badge hb-uz-badge-${kind}`}>{kind.toUpperCase()}</span>
									<span className="hb-uz-tail-model" title={`${row.provider}/${row.model}`}>
										{row.model}
									</span>
									<span className="hb-uz-tail-msg" title={row.errorMessage ?? undefined}>
										{row.errorMessage ?? row.stopReason}
									</span>
								</li>
							);
						})}
					</ul>
				</section>
			)}
		</div>
	);
}
