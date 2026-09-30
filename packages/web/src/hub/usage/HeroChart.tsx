/**
 * The hero chart: stacked cost columns by provider (the operator's "what did
 * things cost" answer) with the request-count line riding a second scale.
 * Peak bucket annotated, idle buckets visible as gaps, direct end label
 * instead of a legend axis. Hand-rolled SVG — no chart library.
 */
import type { ReactNode } from "react";
import type { UsageRange, UsageProviderSeriesPoint } from "../api";
import { fmtCost, fmtTokens } from "../../lib/format";
import type { ProviderStack } from "./series";
import { bucketLabel, downsampleSeries, sparklinePoints, stackByProvider } from "./series";
import { hueClass } from "./use-now";

const MAX_BUCKETS = 120;

interface Axis {
	timestamps: number[];
	/** Per-provider cost values aligned with `timestamps` (hue order + rest). */
	columns: { provider: string; values: number[] }[];
	costTotals: number[];
	requests: number[];
	stepMs: number;
}

function buildAxis(points: readonly UsageProviderSeriesPoint[]): Axis {
	const stack = stackByProvider(points, point => point.cost);
	const filled = fillAxis(stack);
	// Requests ride the same buckets, summed across every provider.
	const requestsByTime = new Map<number, number>();
	for (const point of points) requestsByTime.set(point.timestamp, (requestsByTime.get(point.timestamp) ?? 0) + point.requests);
	const requests = filled.timestamps.map(time => requestsByTime.get(time) ?? 0);
	return { ...filled, requests };
}

/** Zero-fills the stack onto its natural step, then downsamples long ranges. */
function fillAxis(stack: ProviderStack): Omit<Axis, "requests" | "stepMs"> & { stepMs: number } {
	const totals = stack.totals.map((value, index) => ({ timestamp: stack.timestamps[index]!, value }));
	const stepMs = totals.length >= 2 ? totals[1]!.timestamp - totals[0]!.timestamp : 86_400_000;
	const sparse = downsampleSeries(totals, MAX_BUCKETS);
	if (sparse.length === stack.timestamps.length) {
		return { timestamps: stack.timestamps, columns: stack.columns, costTotals: stack.totals, stepMs };
	}
	// Downsampled: regroup every provider column with the same grouping.
	const groupSize = Math.ceil(stack.timestamps.length / sparse.length);
	const columns = stack.columns.map(column => {
		const values: number[] = [];
		for (let index = 0; index < column.values.length; index += groupSize) {
			values.push(column.values.slice(index, index + groupSize).reduce((sum, value) => sum + value, 0));
		}
		return { provider: column.provider, values };
	});
	return { timestamps: sparse.map(point => point.timestamp), columns, costTotals: sparse.map(point => point.value), stepMs };
}

const W = 1000;
const H = 210;
const PAD = { top: 22, right: 56, bottom: 22, left: 8 };

export function HeroChart({
	points,
	hues,
	range,
}: {
	points: readonly UsageProviderSeriesPoint[];
	hues: ReadonlyMap<string, number>;
	range: UsageRange;
}): ReactNode {
	const hasData = points.some(point => point.cost > 0 || point.requests > 0);
	if (!hasData) return <p className="hb-uz-empty">no provider activity in this range</p>;

	const axis = buildAxis(points);
	const n = axis.timestamps.length;
	const plotW = W - PAD.left - PAD.right;
	const plotH = H - PAD.top - PAD.bottom;
	const maxCost = Math.max(...axis.costTotals, 0.000001);
	const maxReq = Math.max(...axis.requests, 1);
	const slot = plotW / n;
	const colW = Math.max(Math.min(slot * 0.72, 42), 2);
	const step = axis.stepMs;
	const peakIndex = axis.costTotals.indexOf(Math.max(...axis.costTotals));

	const linePoints = sparklinePoints(axis.requests.map(value => value / maxReq * plotH), plotW, plotH)
		.split(" ")
		.map(pair => {
			const [x, y] = pair.split(",").map(Number);
			return `${((x ?? 0) + PAD.left).toFixed(1)},${((y ?? 0) + PAD.top).toFixed(1)}`;
		})
		.join(" ");

	const labelIndices = n <= 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];

	return (
		<div className="hb-uz-hero">
			<div className="hb-uz-hero-legend">
				{axis.columns.map(column => (
					<span className="hb-uz-legend-item" key={column.provider}>
						<span className={`hb-uz-swatch ${hueClass(hues.get(column.provider) ?? -1)}`} aria-hidden="true" />
						{column.provider === "rest" ? `rest (${axis.columns.length - 1} more)` : column.provider}
					</span>
				))}
				<span className="hb-uz-legend-item hb-uz-legend-muted">
					<span className="hb-uz-swatch hb-uz-req-swatch" aria-hidden="true" />
					requests
				</span>
			</div>
			<svg className="hb-uz-hero-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`API-equivalent cost and requests per bucket over ${range}`}>
				<line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} className="hb-uz-axis" />
				{axis.timestamps.map((time, index) => {
					const x = PAD.left + index * slot + (slot - colW) / 2;
					let yCursor = PAD.top + plotH;
					const cost = axis.costTotals[index]!;
					const segments = axis.columns
						.map(column => ({ provider: column.provider, value: column.values[index]! }))
						.filter(segment => segment.value > 0);
					return (
						<g key={time} className="hb-uz-hero-col">
							<title>
								{`${bucketLabel(time, step)} — ${fmtCost(cost)} · ${axis.requests[index]} requests`}
							</title>
							<rect x={x} y={PAD.top} width={colW} height={plotH} className="hb-uz-hero-hover" />
							{segments.map(segment => {
								const height = Math.max((segment.value / maxCost) * plotH, segment.value > 0 ? 1.5 : 0);
								yCursor -= height;
								return (
									<rect
										key={segment.provider}
										x={x}
										y={yCursor}
										width={colW}
										height={height}
										className={hueClass(hues.get(segment.provider) ?? -1)}
									/>
								);
							})}
						</g>
					);
				})}
				<polyline points={linePoints} className="hb-uz-hero-reqline" />
				<text
					x={PAD.left + (peakIndex + 0.5) * slot}
					y={PAD.top + plotH - (axis.costTotals[peakIndex]! / maxCost) * plotH - 6}
					className="hb-uz-hero-peak"
				>
					{`peak ${fmtCost(axis.costTotals[peakIndex]!)}`}
				</text>
				<text x={PAD.left + n * slot} y={PAD.top + plotH - (axis.costTotals[n - 1]! / maxCost) * plotH + 4} className="hb-uz-hero-end">
					{fmtCost(axis.costTotals[n - 1]!)}
				</text>
				{labelIndices.map(index => (
					<text
						key={axis.timestamps[index]!}
						x={Math.min(PAD.left + (index + 0.5) * slot, W - 4)}
						y={H - 6}
						className={`hb-uz-axis-label${index === n - 1 ? " hb-uz-axis-end" : ""}`}
						textAnchor={index === 0 ? "start" : index === n - 1 ? "end" : "middle"}
					>
						{bucketLabel(axis.timestamps[index]!, step)}
					</text>
				))}
			</svg>
			<p className="hb-uz-hero-note">{fmtTokens(axis.requests.reduce((sum, value) => sum + value, 0))} requests across {n} buckets</p>
		</div>
	);
}
