/**
 * Machine usage (docs/protocol.md §5): a hub-native view over the machine's
 * local omp stats dashboard, relayed through `/api/machines/:id/usage/*`
 * (§3). The shape is the dashboard's `/api/stats` payload; the rendering is
 * ours. Machines are polled like the home page so the header tracks the live
 * connection state.
 */
import { Activity, ChevronLeft, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { fmtCost, fmtDuration, fmtPercent, fmtTokens, relTime } from "../lib/format";
import {
	type MachineRecord,
	type MachineUsageStats,
	type UsageModelStats,
	type UsageRange,
	type UsageTimePoint,
	errorText,
	getMachineUsage,
	getMachines,
	syncMachineUsage,
} from "./api";
import { navigate } from "./router";

const MACHINE_POLL_MS = 2000;

const RANGES: { value: UsageRange; label: string }[] = [
	{ value: "1h", label: "1h" },
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
	{ value: "all", label: "all" },
];

export function UsagePage({ machineId }: { machineId: string }): ReactNode {
	const [machines, setMachines] = useState<MachineRecord[]>([]);
	const [range, setRange] = useState<UsageRange>("24h");
	const [stats, setStats] = useState<MachineUsageStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [syncing, setSyncing] = useState(false);

	const machine = machines.find(m => m.machineId === machineId);

	// The machine list is only used for the header (name + live dot); failures
	// are silent here — the stats fetch surfaces real problems in `error`.
	useEffect(() => {
		let cancelled = false;
		const poll = (): void => {
			void getMachines()
				.then(list => {
					if (!cancelled) setMachines(list);
				})
				.catch(() => {});
		};
		poll();
		const timer = setInterval(poll, MACHINE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	const load = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			setStats(await getMachineUsage(machineId, range));
			setError(null);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(false);
		}
	}, [machineId, range]);

	useEffect(() => {
		void load();
	}, [load]);

	const sync = useCallback(async (): Promise<void> => {
		setSyncing(true);
		try {
			await syncMachineUsage(machineId);
			setStats(await getMachineUsage(machineId, range));
			setError(null);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSyncing(false);
		}
	}, [machineId, range]);

	return (
		<div className="hb-page">
			<header className="hb-top">
				<div className="hb-usage-head">
					<button type="button" className="sh-btn" onClick={() => navigate("/")} aria-label="back to hub">
						<ChevronLeft size={14} aria-hidden="true" />
					</button>
					<span
						className={`hb-dot hb-dot-${machine?.connected ? "live" : "exited"}`}
						aria-label={machine?.connected ? "connected" : "offline"}
					/>
					<h1 className="hb-usage-title">{machine?.name ?? machineId}</h1>
					<span className="hb-machine-id">{machineId}</span>
				</div>
				<div className="hb-top-actions">
					<select
						className="sh-input hb-usage-range"
						value={range}
						onChange={e => setRange(e.target.value as UsageRange)}
						aria-label="time range"
					>
						{RANGES.map(r => (
							<option key={r.value} value={r.value}>
								{r.label}
							</option>
						))}
					</select>
					<button type="button" className="sh-btn" onClick={() => void sync()} disabled={syncing || busy}>
						<RefreshCw size={14} className={syncing ? "hb-spin" : undefined} aria-hidden="true" />
						<span className="sh-btn-label">{syncing ? "syncing…" : "Sync"}</span>
					</button>
					<button type="button" className="sh-btn" onClick={() => void load()} disabled={busy}>
						<Activity size={14} aria-hidden="true" />
						<span className="sh-btn-label">{busy ? "loading…" : "Refresh"}</span>
					</button>
				</div>
			</header>

			{error && (
				<div className="hb-banner" role="alert">
					{error}
				</div>
			)}

			{stats && <UsageBody stats={stats} />}
		</div>
	);
}

function UsageBody({ stats }: { stats: MachineUsageStats }): ReactNode {
	const overall = stats.overall;
	const allUnpriced = overall.totalRequests > 0 && overall.unpricedRequests >= overall.totalRequests;
	return (
		<div className="hb-grid">
			<section className="hb-card">
				<h2 className="hb-card-title">Overview</h2>
				<div className="hb-usage-cards">
					<UsageCard
						label="requests"
						value={String(overall.totalRequests)}
						sub={`${overall.failedRequests} failed · ${fmtPercent(overall.errorRate * 100)} error`}
					/>
					<UsageCard
						label="tokens"
						value={`${fmtTokens(overall.totalInputTokens)} in / ${fmtTokens(overall.totalOutputTokens)} out`}
						sub={`${fmtTokens(overall.totalCacheReadTokens)} cache read · ${fmtTokens(overall.totalCacheWriteTokens)} write`}
					/>
					<UsageCard
						label="cache"
						value={`${fmtPercent(overall.cacheRate * 100)} hit`}
						sub={`${fmtPercent(overall.cacheSavings * 100)} prompt cost saved`}
					/>
					<UsageCard
						label="API-equivalent"
						value={allUnpriced ? "n/a" : fmtCost(overall.totalCost)}
						sub={allUnpriced ? "subscription-backed usage" : `${overall.unpricedRequests} unpriced requests`}
					/>
					<UsageCard
						label="latency"
						value={overall.avgDuration === null ? "—" : fmtDuration(overall.avgDuration)}
						sub={overall.avgTtft === null ? "no ttft data" : `ttft ${fmtDuration(overall.avgTtft)}`}
					/>
					<UsageCard
						label="speed"
						value={overall.avgTokensPerSecond === null ? "—" : `${fmtTokens(overall.avgTokensPerSecond)} tok/s`}
						sub={
							overall.lastTimestamp > 0 ? `last request ${relTime(overall.lastTimestamp)}` : "no activity"
						}
					/>
				</div>
			</section>

			<section className="hb-card">
				<h2 className="hb-card-title">Requests over time</h2>
				<UsageChart points={stats.timeSeries} />
			</section>

			<section className="hb-card">
				<h2 className="hb-card-title">By model</h2>
				<UsageModels models={stats.byModel} />
			</section>
		</div>
	);
}

function UsageCard({ label, value, sub }: { label: string; value: string; sub: string }): ReactNode {
	return (
		<div className="hb-usage-card">
			<span className="hb-usage-card-label">{label}</span>
			<span className="hb-usage-card-value">{value}</span>
			<span className="hb-usage-card-sub">{sub}</span>
		</div>
	);
}

/** DOM bar chart: one flex column per bucket; errors stack in red underneath. */
function UsageChart({ points }: { points: UsageTimePoint[] }): ReactNode {
	if (points.length === 0) return <p className="hb-empty">no requests in this range</p>;
	const max = Math.max(...points.map(p => p.requests), 1);
	return (
		<div className="hb-usage-chart" role="img" aria-label="requests per time bucket">
			{points.map(p => (
				<div
					key={p.timestamp}
					className="hb-usage-bar"
					title={`${new Date(p.timestamp).toLocaleString()} — ${p.requests} requests, ${p.errors} errors, ${fmtTokens(p.tokens)} tokens, ${fmtCost(p.cost)}`}
				>
					<span className="hb-usage-bar-req" style={{ height: `${Math.max((p.requests / max) * 100, p.requests > 0 ? 2 : 0)}%` }} />
					<span className="hb-usage-bar-err" style={{ height: `${(p.errors / max) * 100}%` }} />
				</div>
			))}
			<div className="hb-usage-axis">
				<span>{relTime(points[0]!.timestamp)}</span>
				<span>{relTime(points[points.length - 1]!.timestamp)}</span>
			</div>
		</div>
	);
}

function UsageModels({ models }: { models: UsageModelStats[] }): ReactNode {
	if (models.length === 0) return <p className="hb-empty">no model usage in this range</p>;
	return (
		<div className="hb-usage-table-wrap">
			<table className="hb-usage-table">
				<thead>
					<tr>
						<th>model</th>
						<th>provider</th>
						<th className="hb-num">requests</th>
						<th className="hb-num">failed</th>
						<th className="hb-num">tokens</th>
						<th className="hb-num">cache hit</th>
						<th className="hb-num">API-equivalent</th>
						<th className="hb-num">tok/s</th>
					</tr>
				</thead>
				<tbody>
					{models.map(m => {
						const unpriced = m.totalRequests > 0 && m.unpricedRequests >= m.totalRequests;
						return (
							<tr key={`${m.provider}/${m.model}`}>
								<td className="hb-mono">{m.model}</td>
								<td>{m.provider}</td>
								<td className="hb-num">{m.totalRequests}</td>
								<td className="hb-num">{m.failedRequests}</td>
								<td className="hb-num">{fmtTokens(m.totalInputTokens + m.totalOutputTokens)}</td>
								<td className="hb-num">{fmtPercent(m.cacheRate * 100)}</td>
								<td className="hb-num">{unpriced ? "n/a" : fmtCost(m.totalCost)}</td>
								<td className="hb-num">{m.avgTokensPerSecond === null ? "—" : `${fmtTokens(m.avgTokensPerSecond)}/s`}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
