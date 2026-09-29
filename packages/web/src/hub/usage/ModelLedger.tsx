/**
 * The model ledger: one sortable row per provider/model with request-share
 * bars in-cell, a token-mix mini stack, per-row request trend sparkline, and
 * state-colored failure/TTFT signals. Replaces the static "By model" table.
 * Sorting is a plain comparator on copy — no React row thrash beyond the
 * sorted map.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { MachineDashboardStats, UsageModelSeriesPoint, UsageModelStats } from "../api";
import { fmtCost, fmtDuration, fmtPercent, fmtTokens } from "../../lib/format";
import { sparklinePoints } from "./series";
import { hueClass } from "./use-now";

type SortKey = "requests" | "cost" | "tokens" | "ttft" | "speed" | "cache";

const SORTS: readonly { key: SortKey; label: string; value: (row: UsageModelStats) => number }[] = [
	{ key: "requests", label: "req", value: row => row.totalRequests },
	{ key: "cost", label: "API-eq", value: row => row.totalCost },
	{ key: "tokens", label: "tokens", value: row => row.totalInputTokens + row.totalOutputTokens },
	{ key: "ttft", label: "ttft", value: row => row.avgTtft ?? -1 },
	{ key: "speed", label: "tok/s", value: row => row.avgTokensPerSecond ?? -1 },
	{ key: "cache", label: "cache", value: row => row.cacheRate },
];

const TTFT_WARN_MS = 10_000;
const TREND_BUCKETS = 14;

/** Last TREND_BUCKETS bucket timestamps of the model series (the shared trend axis). */
function trendAxis(series: readonly UsageModelSeriesPoint[]): number[] {
	const times = [...new Set(series.map(point => point.timestamp))].sort((a, b) => a - b);
	return times.slice(-TREND_BUCKETS);
}

export function ModelLedger({
	dashboard,
	hues,
}: {
	dashboard: MachineDashboardStats;
	hues: ReadonlyMap<string, number>;
}): ReactNode {
	const [sort, setSort] = useState<SortKey>("requests");
	const axis = useMemo(() => trendAxis(dashboard.modelSeries), [dashboard.modelSeries]);
	const seriesByModel = useMemo(() => {
		const map = new Map<string, number[]>();
		if (axis.length === 0) return map;
		for (const row of dashboard.byModel) map.set(`${row.provider}\u0000${row.model}`, axis.map(() => 0));
		for (const point of dashboard.modelSeries) {
			const values = map.get(`${point.provider}\u0000${point.model}`);
			const index = axis.indexOf(point.timestamp);
			if (values && index >= 0) values[index] += point.requests;
		}
		return map;
	}, [dashboard, axis]);

	const maxRequests = Math.max(...dashboard.byModel.map(row => row.totalRequests), 1);
	const sorted = [...dashboard.byModel].sort((a, b) => {
		const pick = SORTS.find(entry => entry.key === sort)!;
		return pick.value(b) - pick.value(a);
	});

	if (dashboard.byModel.length === 0) return <p className="hb-uz-empty">no model usage in this range</p>;

	return (
		<div className="hb-uz-ledger-wrap">
			<table className="hb-uz-ledger">
				<thead>
					<tr>
						<th scope="col">model</th>
						<th scope="col" className="hb-uz-col-share">share of requests</th>
						<th scope="col" className="hb-num" aria-sort={sort === "requests" ? "descending" : undefined}>
							<button type="button" className={`hb-uz-sort${sort === "requests" ? " hb-uz-sort-on" : ""}`} onClick={() => setSort("requests")}>req</button>
						</th>
						<th scope="col" className="hb-num">failed</th>
						<th scope="col" className="hb-num" aria-sort={sort === "tokens" ? "descending" : undefined}>
							<button type="button" className={`hb-uz-sort${sort === "tokens" ? " hb-uz-sort-on" : ""}`} onClick={() => setSort("tokens")}>tokens</button>
						</th>
						<th scope="col" className="hb-uz-cell-mix">mix</th>
						<th scope="col" className="hb-num" aria-sort={sort === "cache" ? "descending" : undefined}>
							<button type="button" className={`hb-uz-sort${sort === "cache" ? " hb-uz-sort-on" : ""}`} onClick={() => setSort("cache")}>cache</button>
						</th>
						<th scope="col" className="hb-num" aria-sort={sort === "speed" ? "descending" : undefined}>
							<button type="button" className={`hb-uz-sort${sort === "speed" ? " hb-uz-sort-on" : ""}`} onClick={() => setSort("speed")}>tok/s</button>
						</th>
						<th scope="col" className="hb-num" aria-sort={sort === "ttft" ? "descending" : undefined}>
							<button type="button" className={`hb-uz-sort${sort === "ttft" ? " hb-uz-sort-on" : ""}`} onClick={() => setSort("ttft")}>ttft</button>
						</th>
						<th scope="col" className="hb-num" aria-sort={sort === "cost" ? "descending" : undefined}>
							<button type="button" className={`hb-uz-sort${sort === "cost" ? " hb-uz-sort-on" : ""}`} onClick={() => setSort("cost")}>API-eq</button>
						</th>
						<th scope="col" className="hb-uz-col-trend">trend</th>
					</tr>
				</thead>
				<tbody>
					{sorted.map(row => {
						const unpriced = row.totalRequests > 0 && row.unpricedRequests >= row.totalRequests;
						const totalTokens = row.totalInputTokens + row.totalOutputTokens + row.totalCacheReadTokens + row.totalCacheWriteTokens;
						const trend = seriesByModel.get(`${row.provider}\u0000${row.model}`) ?? [];
						const failRate = row.totalRequests > 0 ? row.failedRequests / row.totalRequests : 0;
						return (
							<tr key={`${row.provider}/${row.model}`}>
								<td className="hb-uz-cell-model">
									<span className={`hb-uz-swatch ${hueClass(hues.get(row.provider) ?? -1)}`} aria-hidden="true" />
									<span className="hb-mono">{row.model}</span>
									<span className="hb-uz-cell-provider">{row.provider}</span>
								</td>
								<td className="hb-uz-cell-share">
									<span className="hb-uz-sharebar" aria-hidden="true">
										<span style={{ width: `${(row.totalRequests / maxRequests) * 100}%` }} />
									</span>
									<span className="hb-uz-share-num">{fmtPercent((row.totalRequests / maxRequests) * 100)}</span>
								</td>
								<td className="hb-num">{row.totalRequests}</td>
								<td className="hb-num">
									{row.failedRequests > 0 && (
										<span className={`hb-uz-faildot${failRate > 0.05 ? " hb-uz-faildot-hot" : ""}`} title={`${row.failedRequests} failed (${(failRate * 100).toFixed(1)}%)`}>
											●
										</span>
									)}
									{row.failedRequests}
								</td>
								<td className="hb-num">{fmtTokens(row.totalInputTokens + row.totalOutputTokens)}</td>
								<td className="hb-uz-cell-mix" title={`in ${fmtTokens(row.totalInputTokens)} · out ${fmtTokens(row.totalOutputTokens)} · read ${fmtTokens(row.totalCacheReadTokens)} · write ${fmtTokens(row.totalCacheWriteTokens)}`}>
									{totalTokens > 0 && (
										<span className="hb-uz-mixbar" aria-hidden="true">
											<span className="hb-uz-mix-in" style={{ width: `${(row.totalInputTokens / totalTokens) * 100}%` }} />
											<span className="hb-uz-mix-out" style={{ width: `${(row.totalOutputTokens / totalTokens) * 100}%` }} />
											<span className="hb-uz-mix-read" style={{ width: `${(row.totalCacheReadTokens / totalTokens) * 100}%` }} />
											<span className="hb-uz-mix-write" style={{ width: `${(row.totalCacheWriteTokens / totalTokens) * 100}%` }} />
										</span>
									)}
								</td>
								<td className="hb-num">{fmtPercent(row.cacheRate * 100)}</td>
								<td className="hb-num">{row.avgTokensPerSecond === null ? "—" : `${fmtTokens(row.avgTokensPerSecond)}/s`}</td>
								<td className={`hb-num${(row.avgTtft ?? 0) > TTFT_WARN_MS ? " hb-uz-ttft-warn" : ""}`}>
									{row.avgTtft === null ? "—" : fmtDuration(row.avgTtft)}
								</td>
								<td className="hb-num">{unpriced ? "n/a" : fmtCost(row.totalCost)}</td>
								<td className="hb-uz-cell-trend">
									{trend.length >= 2 && (
										<svg viewBox="0 0 64 16" preserveAspectRatio="none" aria-hidden="true">
											<polyline points={sparklinePoints(trend, 64, 16)} />
										</svg>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
