/**
 * Burn-down history lanes: per (account, window) used-fraction over time.
 * The endpoint only carries series when fetched with a `provider` filter, so
 * the panel hands us pre-joined lanes; a lane with fewer than two snapshots
 * renders the honest "no snapshot history yet" state instead of a invented
 * shape. Reset hairlines mark observed window drops, red dots mark
 * exhausted snapshots, the right edge pins the live value.
 */
import type { ReactNode } from "react";
import type { UsageWindowSeries } from "../api";
import { normalizeFraction } from "./insights";

const W = 320;
const H = 44;
const PAD = 4;

interface LaneGeometry {
	line: string;
	resets: number[];
	exhausted: string[];
	endLabel: string;
}

function laneGeometry(series: UsageWindowSeries): LaneGeometry | null {
	const points = series.points;
	if (points.length < 2) return null;
	const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
	const values = sorted.map(point => Math.min(normalizeFraction(point.usedFraction) ?? 0, 1));
	const span = sorted[sorted.length - 1]!.timestamp - sorted[0]!.timestamp || 1;
	const x = (index: number): number => PAD + ((sorted[index]!.timestamp - sorted[0]!.timestamp) / span) * (W - PAD * 2);
	const y = (fraction: number): number => H - PAD - fraction * (H - PAD * 2);
	const line = sorted.map((_, index) => `${x(index).toFixed(1)},${y(values[index]!).toFixed(1)}`).join(" ");
	const resets: number[] = [];
	const exhausted: string[] = [];
	for (let index = 1; index < sorted.length; index++) {
		const drop = values[index - 1]! - values[index]!;
		if (drop > 0.4) resets.push(x(index));
		if (sorted[index]!.exhausted) exhausted.push(`${x(index).toFixed(1)},${y(values[index]!).toFixed(1)}`);
	}
	const last = values[values.length - 1]!;
	return { line, resets, exhausted, endLabel: `${Math.round(last * 100)}%` };
}

export function BurnDownLanes({ series }: { series: readonly UsageWindowSeries[] }): ReactNode {
	const lanes = series.map(lane => ({ lane, geometry: laneGeometry(lane) }));
	if (lanes.length === 0 || lanes.every(entry => entry.geometry === null)) {
		return (
			<p className="hb-uz-empty">
				no snapshot history yet — usage-window samples accrue as the machine's auth broker records quota usage
			</p>
		);
	}

	return (
		<div className="hb-uz-lanes">
			{lanes.map(({ lane, geometry }) => (
				<div className="hb-uz-lane" key={`${lane.provider}:${lane.accountKey}:${lane.windowKey}`}>
					<span className="hb-uz-lane-label" title={`${lane.provider} · ${lane.accountLabel}`}>
						{lane.accountLabel} <span className="hb-uz-lane-window">· {lane.windowLabel}</span>
					</span>
					{geometry === null ? (
						<span className="hb-uz-lane-empty">no snapshots yet</span>
					) : (
						<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${lane.accountLabel} ${lane.windowLabel} burn-down`}>
							{geometry.resets.map((x, index) => (
								<line key={index} x1={x} y1={PAD} x2={x} y2={H - PAD} className="hb-uz-lane-reset" />
							))}
							<polyline points={geometry.line} className="hb-uz-lane-line" />
							{geometry.exhausted.map((point, index) => (
								<circle key={index} cx={point.split(",")[0]} cy={point.split(",")[1]} r={2.4} className="hb-uz-lane-exhausted" />
							))}
							<text x={W - 2} y={H / 2 + 3} className="hb-uz-lane-end">
								{geometry.endLabel}
							</text>
						</svg>
					)}
				</div>
			))}
		</div>
	);
}
