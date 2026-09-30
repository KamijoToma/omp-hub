/**
 * Cost anatomy: one stacked bar splitting API-equivalent spend into
 * input / output / cache-read / cache-write. The only component that answers
 * "where does the money actually go" — on real data cache reads dominate.
 * The unpriced chip renders only when unpriced requests exist.
 */
import type { ReactNode } from "react";
import type { UsageCostPoint } from "../api";
import { fmtCost, fmtPercent } from "../../lib/format";

interface Segment {
	key: string;
	label: string;
	value: number;
}

/** Segment colors are composition-shades, not state or provider hues. */
const SEGMENT_CLASS: Record<string, string> = {
	input: "hb-uz-anat-input",
	output: "hb-uz-anat-output",
	cacheRead: "hb-uz-anat-read",
	cacheWrite: "hb-uz-anat-write",
};

export function CostAnatomy({ costSeries }: { costSeries: readonly UsageCostPoint[] }): ReactNode {
	const totals = costSeries.reduce(
		(acc, point) => ({
			input: acc.input + point.costInput,
			output: acc.output + point.costOutput,
			cacheRead: acc.cacheRead + point.costCacheRead,
			cacheWrite: acc.cacheWrite + point.costCacheWrite,
			unpriced: acc.unpriced + point.unpricedRequests,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpriced: 0 },
	);
	const segments: Segment[] = [
		{ key: "input", label: "input", value: totals.input },
		{ key: "output", label: "output", value: totals.output },
		{ key: "cacheRead", label: "cache read", value: totals.cacheRead },
		{ key: "cacheWrite", label: "cache write", value: totals.cacheWrite },
	];
	const total = segments.reduce((sum, segment) => sum + segment.value, 0);
	if (total <= 0) return <p className="hb-uz-empty">no priced cost in this range</p>;

	return (
		<div className="hb-uz-anatomy">
			<div className="hb-uz-anat-bar" role="img" aria-label={segments.map(segment => `${segment.label} ${fmtPercent((segment.value / total) * 100)}`).join(", ")}>
				{segments
					.filter(segment => segment.value > 0)
					.map(segment => (
						<span
							key={segment.key}
							className={`hb-uz-anat-seg ${SEGMENT_CLASS[segment.key]}`}
							style={{ width: `${Math.max((segment.value / total) * 100, 1.2)}%` }}
							title={`${segment.label} ${fmtCost(segment.value)} (${fmtPercent((segment.value / total) * 100)})`}
						/>
					))}
			</div>
			<dl className="hb-uz-anat-legend">
				{segments.map(segment => (
					<div className="hb-uz-anat-row" key={segment.key}>
						<span className={`hb-uz-swatch ${SEGMENT_CLASS[segment.key]}`} aria-hidden="true" />
						<dt>{segment.label}</dt>
						<dd>
							{fmtCost(segment.value)} · {fmtPercent((segment.value / total) * 100)}
						</dd>
					</div>
				))}
			</dl>
			{totals.unpriced > 0 && <p className="hb-uz-anat-unpriced">{totals.unpriced} unpriced requests excluded</p>}
		</div>
	);
}
