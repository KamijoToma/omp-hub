/**
 * Hour-of-day burn grid: 24 cells per provider, top rows by token burn plus
 * an all-providers Σ row. Log-scaled alpha keeps the midnight cliff and the
 * noon hum readable in one grid; the caption states the peak window share so
 * the "when do I burn quota" question answers itself.
 */
import type { ReactNode } from "react";
import type { UsageProviderHourPoint } from "../api";
import { fmtTokens } from "../../lib/format";
import { peakBurnWindow } from "./insights";
import { heatAlpha, hourSpanLabel } from "./series";
import { hueClass } from "./use-now";

const MAX_ROWS = 6;

export function HourHeat({
	hourly,
	hues,
}: {
	hourly: readonly UsageProviderHourPoint[];
	hues: ReadonlyMap<string, number>;
}): ReactNode {
	if (hourly.length === 0) return <p className="hb-uz-empty">no burn data in this range</p>;

	const byProvider = new Map<string, { cells: number[]; total: number }>();
	for (const point of hourly) {
		let row = byProvider.get(point.provider);
		if (!row) {
			row = { cells: new Array<number>(24).fill(0), total: 0 };
			byProvider.set(point.provider, row);
		}
		row.cells[point.hour] += point.totalTokens;
		row.total += point.totalTokens;
	}

	const ranked = [...byProvider.entries()].sort((a, b) => b[1].total - a[1].total);
	const top = ranked.slice(0, MAX_ROWS);
	const sum = new Array<number>(24).fill(0);
	for (const point of hourly) sum[point.hour] += point.totalTokens;
	const grandTotal = sum.reduce((a, b) => a + b, 0);

	return (
		<div className="hb-uz-heat">
			<div className="hb-uz-heat-rows" role="img" aria-label="token burn by hour of day per provider">
				{top.map(([provider, row]) => {
					const rowMax = Math.max(...row.cells);
					return (
						<div className="hb-uz-heat-row" key={provider}>
							<span className="hb-uz-heat-label" title={provider}>
								<span className={`hb-uz-swatch ${hueClass(hues.get(provider) ?? -1)}`} aria-hidden="true" />
								{provider}
							</span>
							<span className="hb-uz-heat-cells">
								{row.cells.map((value, hour) => (
									<span
										key={hour}
										className={`hb-uz-heat-cell ${hueClass(hues.get(provider) ?? -1)}`}
										style={{ opacity: value > 0 ? heatAlpha(value, rowMax) : 0 }}
										title={`${provider} · ${String(hour).padStart(2, "0")}:00 — ${fmtTokens(value)} tokens`}
									/>
								))}
							</span>
							<span className="hb-uz-heat-total">{fmtTokens(row.total)}</span>
						</div>
					);
				})}
				<div className="hb-uz-heat-row hb-uz-heat-sum">
					<span className="hb-uz-heat-label">Σ</span>
					<span className="hb-uz-heat-cells">
						{sum.map((value, hour) => (
							<span
								key={hour}
								className="hb-uz-heat-cell hb-uz-heat-cell-sum"
								style={{ opacity: value > 0 ? heatAlpha(value, Math.max(...sum)) : 0 }}
								title={`${String(hour).padStart(2, "0")}:00 — ${fmtTokens(value)} tokens (all providers)`}
							/>
						))}
					</span>
					<span className="hb-uz-heat-total">{fmtTokens(grandTotal)}</span>
				</div>
			</div>
			<div className="hb-uz-heat-axis" aria-hidden="true">
				{[0, 6, 12, 18, 23].map(hour => (
					<span key={hour}>{String(hour).padStart(2, "0")}</span>
				))}
			</div>
			{(() => {
				const peak = peakBurnWindow(hourly);
				return peak && (
					<p className="hb-uz-heat-note">
						<strong>{Math.round(peak.share * 100)}% of burn</strong> lands {peak.label} local — schedule window resets ahead of it
					</p>
				);
			})()}
			{ranked.length > top.length && <p className="hb-uz-heat-more">+{ranked.length - top.length} providers below the top rows</p>}
		</div>
	);
}
