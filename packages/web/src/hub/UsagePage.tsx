/**
 * Machine usage: historical statistics and live subscription quotas for one
 * selected profile (or separate account-level reports for each profile).
 */
import { Activity, ChevronLeft, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtCost, fmtDuration, fmtPercent, fmtTokens, relTime } from "../lib/format";
import {
	type MachineRecord,
	type MachineUsageStats,
	type SubscriptionLimit,
	type SubscriptionUsage,
	type UsageModelStats,
	type UsageRange,
	type UsageTimePoint,
	errorText,
	getMachineSubscriptions,
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

/** Selection values: `"all"` (separate per-profile reports), `"default"`, or a named profile. */
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
	const [view, setView] = useState<"statistics" | "subscriptions">("statistics");
	/** Named profiles; `null` until the first listing answers. */
	const [profiles, setProfiles] = useState<string[] | null>(null);
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
		if ((profile === "all" && profiles.length === 0) || (profile !== "all" && profile !== "default" && !profiles.includes(profile))) {
			setProfile("default");
			storeProfile("default");
		}
	}, [profile, profiles]);

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
					{view === "statistics" && (
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
					)}
				</div>
			</header>
			<nav className="hb-role-tabs hb-usage-views" aria-label="Usage views">
				{(["statistics", "subscriptions"] as const).map(choice => (
					<button
						type="button"
						key={choice}
						className={`hb-role-tab${view === choice ? " hb-role-tab-current" : ""}`}
						aria-pressed={view === choice}
						onClick={() => setView(choice)}
					>
						{choice === "statistics" ? "Statistics" : "Subscriptions"}
					</button>
				))}
			</nav>
			{view === "statistics" ? (
				<StatisticsPanel
					key={`${machineId}:${profile}:${range}:${profiles?.join("\u0000") ?? ""}`}
					machineId={machineId}
					profile={profile}
					profiles={profiles}
					range={range}
				/>
			) : profiles === null || (profile !== "default" && profile !== "all" && !profiles.includes(profile)) || (profile === "all" && profiles.length === 0) ? (
				<p className="hb-empty" role="status">Loading profiles…</p>
			) : (
				<SubscriptionsPanel
					key={`${machineId}:${profile}:${profiles?.join("\u0000") ?? ""}`}
					machineId={machineId}
					profile={profile}
					profiles={profiles}
				/>
			)}
		</div>
	);
}

function StatisticsPanel({
	machineId, profile, profiles, range,
}: {
	machineId: string;
	profile: ProfileSelection;
	profiles: string[] | null;
	range: UsageRange;
}): ReactNode {
	const [stats, setStats] = useState<MachineUsageStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [syncing, setSyncing] = useState(false);

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
			await load();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSyncing(false);
		}
	}, [machineId, profile, profiles, load]);

	return (
		<>
			<div className="hb-usage-controls">
				<button type="button" className="sh-btn" onClick={() => void sync()} disabled={syncing || busy}>
					<RefreshCw size={14} className={syncing ? "hb-spin" : undefined} aria-hidden="true" />
					<span className="sh-btn-label">{syncing ? "syncing…" : "Sync"}</span>
				</button>
				<button type="button" className="sh-btn" onClick={() => void load()} disabled={busy}>
					<Activity size={14} aria-hidden="true" />
					<span className="sh-btn-label">{busy ? "loading…" : "Refresh"}</span>
				</button>
			</div>
			{busy && <p className="hb-usage-feedback" role="status">{stats ? "Refreshing statistics; showing previous data." : "Loading statistics…"}</p>}
			{error && <div className="hb-banner" role="alert">{error}{stats && " — showing previous data."}</div>}
			{stats && <UsageBody stats={stats} />}
		</>
	);
}

interface ProfileSubscriptions {
	profile: string;
	usage?: SubscriptionUsage;
	error?: string;
}

function SubscriptionsPanel({ machineId, profile, profiles }: { machineId: string; profile: ProfileSelection; profiles: string[] | null }): ReactNode {
	const [results, setResults] = useState<ProfileSubscriptions[] | null>(null);
	const [busy, setBusy] = useState(false);
	const targets = useMemo(() => profile === "all" ? ["default", ...(profiles ?? [])] : [profile], [profile, profiles]);

	const load = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			const replies = await Promise.allSettled(targets.map(target => getMachineSubscriptions(machineId, target)));
			setResults(previous => replies.map((reply, index): ProfileSubscriptions => {
				const selected = targets[index]!;
				return reply.status === "fulfilled"
					? { profile: selected, usage: reply.value }
					: { profile: selected, usage: previous?.find(item => item.profile === selected)?.usage, error: errorText(reply.reason) };
			}));
		} finally {
			setBusy(false);
		}
	}, [machineId, targets]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<>
			<div className="hb-usage-controls">
				<p className="hb-card-note">Live subscription quotas for this machine, separate from historical statistics.</p>
				<button type="button" className="sh-btn" onClick={() => void load()} disabled={busy}>
					<RefreshCw size={14} className={busy ? "hb-spin" : undefined} aria-hidden="true" />
					<span className="sh-btn-label">{busy ? "loading…" : "Refresh"}</span>
				</button>
			</div>
			{busy && <p className="hb-usage-feedback" role="status">{results ? "Refreshing subscriptions; showing previous data." : "Loading subscriptions…"}</p>}
			{results && (
				<div className="hb-subscriptions">
					{results.map(result => (
						<section className="hb-card" key={result.profile} aria-label={`${result.profile} profile subscriptions`}>
							<h2 className="hb-card-title">{result.profile} profile</h2>
							{result.error && (
								<p className="hb-banner" role="alert">
									{result.error}{result.usage && " — showing previously fetched data."}
								</p>
							)}
							{result.usage && <SubscriptionProfile usage={result.usage} />}
						</section>
					))}
				</div>
			)}
		</>
	);
}

const quotaPercent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function quotaValue(value: number, unit: string): string {
	return `${value} ${unit}`;
}

function SubscriptionProfile({ usage }: { usage: SubscriptionUsage }): ReactNode {
	const unavailable = new Map<string, { provider: string; account: string; count: number }>();
	for (const account of usage.unavailable) {
		const key = `${account.provider}\u0000${account.account}`;
		const group = unavailable.get(key);
		if (group) group.count++;
		else unavailable.set(key, { ...account, count: 1 });
	}
	return (
		<>
			<p className="hb-card-note">Fetched {new Date(usage.fetchedAt).toLocaleString()}</p>
			{usage.reports.length === 0 && usage.unavailable.length === 0 && (
				<p className="hb-empty">No subscription accounts found for this profile.</p>
			)}
			{usage.reports.map((report, index) => (
				<section className="hb-subscription-account" key={`${report.provider}:${report.account}:${index}`}>
					<h3 className="hb-subscription-heading">{report.provider} · {report.account}</h3>
					<p className="hb-card-note">Updated {new Date(report.fetchedAt).toLocaleString()}</p>
					{report.limits.length === 0 && <p className="hb-empty">No quota windows reported for this account.</p>}
					{report.limits.map((limit, limitIndex) => (
						<SubscriptionQuota key={`${limit.id}:${limit.window?.id ?? ""}:${limitIndex}`} limit={limit} />
					))}
					{report.resetCredits && (
						<p className="hb-card-note">
							Reset credits: {report.resetCredits.availableCount} available
							{report.resetCredits.redeemableCount !== undefined && ` · ${report.resetCredits.redeemableCount} redeemable`}
						</p>
					)}
				</section>
			))}
			{[...unavailable.values()].map(account => (
				<p className="hb-subscription-unavailable" key={`${account.provider}:${account.account}`}>
					{account.provider} · {account.account}{account.count > 1 ? ` ×${account.count}` : ""}: quota unavailable
				</p>
			))}
		</>
	);
}

function SubscriptionQuota({ limit }: { limit: SubscriptionLimit }): ReactNode {
	const { amount, window } = limit;
	const values = [
		amount.used !== undefined && `Used ${quotaValue(amount.used, amount.unit)}`,
		amount.remaining !== undefined && `Remaining ${quotaValue(amount.remaining, amount.unit)}`,
		amount.limit !== undefined && `Limit ${quotaValue(amount.limit, amount.unit)}`,
	].filter((value): value is string => typeof value === "string");
	const fraction = amount.usedFraction !== undefined
		? amount.usedFraction
		: amount.remainingFraction !== undefined ? 1 - amount.remainingFraction : undefined;
	const progress = fraction !== undefined && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : undefined;
	const fractionText = amount.usedFraction !== undefined
		? `${quotaPercent.format(amount.usedFraction * 100)}% used`
		: amount.remainingFraction !== undefined ? `${quotaPercent.format(amount.remainingFraction * 100)}% remaining` : undefined;
	return (
		<div className="hb-subscription-limit">
			<div className="hb-subscription-limit-head">
				<strong>{limit.label}</strong>
				{window && <span>{window.label}</span>}
			</div>
			{values.length > 0 ? <p className="hb-card-note">{values.join(" · ")}</p> : !fractionText && <p className="hb-card-note">No numerical quota reported</p>}
			{progress !== undefined && fractionText && (
				<div className="hb-subscription-progress-line">
					<div
						className="hb-subscription-progress"
						role="progressbar"
						aria-label={`${limit.label}${window ? `, ${window.label}` : ""}`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={progress * 100}
						aria-valuetext={fractionText}
					>
						<span style={{ width: `${progress * 100}%` }} />
					</div>
					<span>{fractionText}</span>
				</div>
			)}
			{window?.resetsAt !== undefined && (
				<p className="hb-card-note">
					{window.resetLabel ?? "Resets"} {new Date(window.resetsAt).toLocaleString()}
				</p>
			)}
			{limit.status && <p className="hb-card-note">Status: {limit.status}</p>}
			{limit.notes?.map((note, index) => <p className="hb-card-note" key={index}>{note}</p>)}
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
