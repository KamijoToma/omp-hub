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
	listMachineProfiles,
	syncMachineUsage,
} from "./api";
import { navigate } from "./router";
import { mergeMachineUsage } from "./usage-merge";

const MACHINE_POLL_MS = 2000;

/** Where the last profile selection persists across page visits. */
const PROFILE_KEY = "omp-hub.usage.profile";

/** Selection values: `"all"` (merged), `"default"`, or a named profile. */
type ProfileSelection = "all" | "default" | string;

function readStoredProfile(): ProfileSelection {
	try {
		return globalThis.localStorage?.getItem(PROFILE_KEY) ?? "default";
	} catch {
		return "default";
	}
}

function storeProfile(profile: ProfileSelection): void {
	try {
		globalThis.localStorage?.setItem(PROFILE_KEY, profile);
	} catch {
		// Storage unavailable (private mode): the choice just stays in memory.
	}
}

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
	const [profile, setProfile] = useState<ProfileSelection>(readStoredProfile);
	/** Named profiles; `null` until the first listing answers. */
	const [profiles, setProfiles] = useState<string[] | null>(null);
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

	// Named profiles for the selector; a failure means the machine has none to
	// offer (offline agent) and the page falls back to the default dashboard.
	useEffect(() => {
		let cancelled = false;
		void listMachineProfiles(machineId)
			.then(found => {
				if (!cancelled) setProfiles(found);
			})
			.catch(() => {
				if (!cancelled) setProfiles([]);
			});
		return () => {
			cancelled = true;
		};
	}, [machineId]);

	// A stored selection can name a profile this machine no longer has — but
	// only judge that once the listing has actually answered.
	useEffect(() => {
		if (profiles === null) return;
		if (profile !== "all" && profile !== "default" && !profiles.includes(profile)) setProfile("default");
	}, [profile, profiles]);

	const load = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			if (profile === "all") {
				const named = profiles ?? [];
				const results = await Promise.allSettled([
					getMachineUsage(machineId, range),
					...named.map(name => getMachineUsage(machineId, range, name)),
				]);
				const ok = results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
				if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
				setStats(mergeMachineUsage(ok));
				const failed = results.length - ok.length;
				setError(failed > 0 ? `${failed}/${results.length} profiles failed to load; showing the rest merged` : null);
			} else {
				setStats(await getMachineUsage(machineId, range, profile));
				setError(null);
			}
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(false);
		}
	}, [machineId, range, profile, profiles]);

	useEffect(() => {
		void load();
	}, [load]);

	const sync = useCallback(async (): Promise<void> => {
		setSyncing(true);
		try {
			const named = profile === "all" ? ["default", ...(profiles ?? [])] : [profile];
			await Promise.all(named.map(target => syncMachineUsage(machineId, target)));
			// load() owns the error banner (including the partial-failure note).
			await load();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSyncing(false);
		}
	}, [machineId, profile, profiles, load]);

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
					{profiles !== null && (
						<select
							className="sh-input hb-usage-range"
							value={profile}
							onChange={e => {
								const next = e.target.value;
								setProfile(next);
								storeProfile(next);
							}}
							aria-label="profile"
						>
							{profiles.length > 0 && <option value="all">all profiles</option>}
							<option value="default">default profile</option>
							{profiles.map(name => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
					)}
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
