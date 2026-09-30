/**
 * Window capacity table: the fleet-sizing answer per provider limit window —
 * how much was consumed, what one window is worth in tokens, peak concurrent
 * demand, and the dashboard's own `idealAccounts` verdict. Sorted by
 * exhaustions first: the windows that ran dry lead.
 */
import type { ReactNode } from "react";
import type { UsageWindowInsight } from "../api";
import { fmtTokens } from "../../lib/format";
import { windowVerdict } from "./insights";

const TONE_CLASS: Record<string, string> = {
	ok: "hb-uz-tone-ok",
	info: "hb-uz-tone-info",
	warn: "hb-uz-tone-warn",
	err: "hb-uz-tone-err",
};

export function WindowCapacity({ insights }: { insights: readonly UsageWindowInsight[] }): ReactNode {
	if (insights.length === 0) return <p className="hb-uz-empty">no usage-window data in range</p>;
	const sorted = [...insights].sort(
		(a, b) => b.exhaustedEvents - a.exhaustedEvents || b.fractionConsumed - a.fractionConsumed,
	);
	const maxConsumed = Math.max(...sorted.map(insight => insight.fractionConsumed), 0.001);

	return (
		<div className="hb-uz-capacity-wrap">
			<table className="hb-uz-capacity">
				<thead>
					<tr>
						<th scope="col">provider · window</th>
						<th scope="col" className="hb-num">accounts</th>
						<th scope="col" className="hb-num">resets</th>
						<th scope="col" className="hb-uz-col-consumed">consumed</th>
						<th scope="col" className="hb-num">tokens/window</th>
						<th scope="col" className="hb-num">peak</th>
						<th scope="col" className="hb-num">ideal</th>
						<th scope="col" className="hb-num">exhaustions</th>
						<th scope="col">verdict</th>
					</tr>
				</thead>
				<tbody>
					{sorted.map(insight => {
						const verdict = windowVerdict(insight);
						return (
							<tr key={insight.windowKey}>
								<td>
									{insight.provider} <span className="hb-uz-lane-window">· {insight.windowLabel}</span>
								</td>
								<td className="hb-num">
									{insight.accounts}
									{insight.accounts >= 20 && <span className="hb-uz-lane-window"> (fleet)</span>}
								</td>
								<td className="hb-num">{insight.cycles}</td>
								<td className="hb-uz-col-consumed">
									<span className="hb-uz-sharebar" aria-hidden="true">
										<span style={{ width: `${Math.min((insight.fractionConsumed / maxConsumed) * 100, 100)}%` }} />
									</span>
									<span className="hb-uz-share-num">{insight.fractionConsumed.toFixed(1)}×</span>
								</td>
								<td className="hb-num">{insight.estTokensPerWindow === null ? "—" : fmtTokens(insight.estTokensPerWindow)}</td>
								<td className="hb-num">×{insight.peakConcurrentFraction.toFixed(2)}</td>
								<td className="hb-num">{insight.idealAccounts}</td>
								<td className={`hb-num${insight.exhaustedEvents > 0 ? " hb-uz-tone-err" : ""}`}>{insight.exhaustedEvents}</td>
								<td className={TONE_CLASS[verdict.tone]}>{verdict.text}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
