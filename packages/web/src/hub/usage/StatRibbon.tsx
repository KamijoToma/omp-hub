/**
 * The hairline stat ribbon: six inline cells replacing raised KPI cards.
 * Cells carry a sparkline (where a bucket series exists) and a contextual
 * sub-line (failed share, worst model, top contributor) — the numbers that
 * make a total meaningful without opening anything.
 */
import type { ReactNode } from "react";
import type { MachineDashboardStats } from "../api";
import { fmtCost, fmtDuration, fmtPercent, fmtTokens } from "../../lib/format";
import { fillBuckets, sparklinePoints } from "./series";

interface RibbonCell {
	label: string;
	value: string;
	sub?: string;
	spark?: readonly number[];
}

function Spark({ values }: { values: readonly number[] }): ReactNode {
	if (values.length < 2) return null;
	return (
		<svg className="hb-uz-rib-spark" viewBox={`0 0 96 20`} preserveAspectRatio="none" aria-hidden="true">
			<polyline points={sparklinePoints(values, 96, 20)} />
		</svg>
	);
}

export function StatRibbon({ dashboard }: { dashboard: MachineDashboardStats }): ReactNode {
	const overall = dashboard.overall;
	const series = dashboard.timeSeries;
	const spark = (pick: (point: (typeof series)[number]) => number): number[] | undefined =>
		series.length >= 2 ? fillBuckets(series.map(point => ({ timestamp: point.timestamp, value: pick(point) }))).map(point => point.value) : undefined;

	const worstTtft = dashboard.byModel
		.filter(row => row.avgTtft !== null && row.totalRequests >= 5)
		.sort((a, b) => (b.avgTtft ?? 0) - (a.avgTtft ?? 0))[0];
	const fastest = [...dashboard.byModel]
		.filter(row => row.avgTokensPerSecond !== null && row.totalRequests >= 5)
		.sort((a, b) => (b.avgTokensPerSecond ?? 0) - (a.avgTokensPerSecond ?? 0))[0];

	const cells: RibbonCell[] = [
		{
			label: "spend",
			value: fmtCost(overall.totalCost),
			sub: overall.totalRequests > 0 ? `${fmtCost(overall.totalCost / overall.totalRequests)}/req` : undefined,
			spark: spark(point => point.cost),
		},
		{
			label: "requests",
			value: String(overall.totalRequests),
			sub: overall.failedRequests > 0 ? `${overall.failedRequests} failed · ${fmtPercent(overall.errorRate * 100)}` : `${overall.failedRequests} failed`,
			spark: spark(point => point.requests),
		},
		{
			label: "tokens",
			value: `${fmtTokens(overall.totalInputTokens)} in · ${fmtTokens(overall.totalOutputTokens)} out`,
			sub: `cache ${fmtTokens(overall.totalCacheReadTokens)} read`,
			spark: spark(point => point.tokens),
		},
		{
			label: "cache hit",
			value: fmtPercent(overall.cacheRate * 100),
			sub: overall.totalRequests > 0 && overall.unpricedRequests >= overall.totalRequests
				? "unpriced usage"
				: `saves ~${fmtPercent(overall.cacheSavings * 100)} of prompt cost`,
		},
		{
			label: "avg ttft",
			value: overall.avgTtft === null ? "—" : fmtDuration(overall.avgTtft),
			sub: worstTtft ? `worst ${worstTtft.model} ${fmtDuration(worstTtft.avgTtft ?? 0)}` : undefined,
		},
		{
			label: "throughput",
			value: overall.avgTokensPerSecond === null ? "—" : `${fmtTokens(overall.avgTokensPerSecond)} tok/s`,
			sub: fastest ? `fastest ${fastest.model} ${fmtTokens(fastest.avgTokensPerSecond ?? 0)}` : undefined,
		},
	];

	return (
		<dl className="hb-uz-ribbon">
			{cells.map(cell => (
				<div className="hb-uz-rib" key={cell.label}>
					<dt className="hb-uz-rib-label">{cell.label}</dt>
					<dd className="hb-uz-rib-value">{cell.value}</dd>
					{cell.sub && <dd className="hb-uz-rib-sub">{cell.sub}</dd>}
					{cell.spark && <Spark values={cell.spark} />}
				</div>
			))}
		</dl>
	);
}
