/**
 * Statistics tab: fetches the five relay endpoints per selected profile (in
 * parallel, any subset may fail), assembles the merged view, and renders the
 * converged section stack — health strip, ribbon, hero chart, anatomy ‖ hour
 * grid, model ledger, activity ‖ error tails, projects strip, provenance.
 * Failures keep the previous data on screen (same contract as before).
 */
import { Activity, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	errorText,
	getMachineUsage,
	getMachineProviderUsage,
	getMachineRecentErrors,
	getMachineRecentRequests,
	getMachineSessionSummaries,
	syncMachineUsage,
	type MachineDashboardStats,
	type MachineProviderUsage,
	type UsageRange,
	type UsageRecentRequest,
	type UsageSessionSummary,
} from "../api";
import { assembleStatistics, type AssembledStatistics, type StatisticsParts } from "./assemble";
import { ActivityTail } from "./ActivityTail";
import { CostAnatomy } from "./CostAnatomy";
import { deriveHealth } from "./insights";
import { HeroChart } from "./HeroChart";
import { HourHeat } from "./HourHeat";
import { ModelLedger } from "./ModelLedger";
import { ProjectsStrip } from "./ProjectsStrip";
import { assignProviderHues } from "./series";
import { StatRibbon } from "./StatRibbon";
import { HealthStrip } from "./HealthStrip";

function ok<T>(result: PromiseSettledResult<T>): T | null {
	return result.status === "fulfilled" ? result.value : null;
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
	return (
		<section className="hb-uz-section">
			<h3 className="hb-uz-sec-title">{title}</h3>
			{children}
		</section>
	);
}

export function StatisticsPanel({
	machineId,
	profile,
	profiles,
	range,
}: {
	machineId: string;
	profile: string;
	profiles: string[];
	range: UsageRange;
}): ReactNode {
	const [data, setData] = useState<AssembledStatistics | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [syncing, setSyncing] = useState(false);

	const load = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			const targets = profile === "all" ? ["default", ...profiles] : [profile];
			const results = await Promise.all(
				targets.map(async target => {
					const settled = await Promise.allSettled([
						getMachineUsage(machineId, range, target),
						getMachineProviderUsage(machineId, range, target),
						getMachineRecentRequests(machineId, 8, target),
						getMachineRecentErrors(machineId, range, 8, target),
						getMachineSessionSummaries(machineId, target),
					]);
					const parts: StatisticsParts = {
						dashboard: ok(settled[0] as PromiseSettledResult<MachineDashboardStats>),
						providers: ok(settled[1] as PromiseSettledResult<MachineProviderUsage>),
						recent: ok(settled[2] as PromiseSettledResult<UsageRecentRequest[]>),
						errors: ok(settled[3] as PromiseSettledResult<UsageRecentRequest[]>),
						sessions: ok(settled[4] as PromiseSettledResult<UsageSessionSummary[]>),
					};
					return parts;
				}),
			);
			const assembled = assembleStatistics(results);
			if (assembled.dashboard === null) throw new Error("stats dashboard unreachable");
			setData(assembled);
			const total = results.length * 5;
			setError(assembled.failedCalls > 0 ? `${assembled.failedCalls}/${total} stats calls failed; showing what answered` : null);
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
			const targets = profile === "all" ? ["default", ...profiles] : [profile];
			await Promise.all(targets.map(target => syncMachineUsage(machineId, target)));
			await load();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSyncing(false);
		}
	}, [machineId, profile, profiles, load]);

	const hues = useMemo(() => {
		const source = data?.providers?.providers ?? [];
		if (source.length > 0) return assignProviderHues(source);
		// Providers-only fallback: rank by cost from the dashboard's model rows.
		const byProvider = new Map<string, { provider: string; totalCost: number }>();
		for (const row of data?.dashboard?.byModel ?? []) {
			const entry = byProvider.get(row.provider) ?? { provider: row.provider, totalCost: 0 };
			entry.totalCost += row.totalCost;
			byProvider.set(row.provider, entry);
		}
		return assignProviderHues([...byProvider.values()]);
	}, [data]);

	const health = useMemo(
		() =>
			data?.dashboard
				? deriveHealth({ overall: data.dashboard.overall, byModel: data.dashboard.byModel, hourly: data.providers?.hourly ?? [] })
				: null,
		[data],
	);

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
			{busy && data !== null && <p className="hb-usage-feedback" role="status">Refreshing statistics; showing previous data.</p>}
			{error && <div className="hb-banner" role="alert">{error}{data !== null && " — showing previous data."}</div>}
			{data?.dashboard ? (
				<div className="hb-uz-tab">
					{health && <HealthStrip verdict={health.verdict} chips={health.chips} busy={busy} />}
					<StatRibbon dashboard={data.dashboard} />
					<Section title="cost over time">
						{data.providers ? (
							<HeroChart points={data.providers.series} hues={hues} range={range} />
						) : (
							<p className="hb-uz-empty">provider series unavailable</p>
						)}
					</Section>
					<div className="hb-uz-cols">
						<Section title="cost anatomy">
							<CostAnatomy costSeries={data.dashboard.costSeries} />
						</Section>
						<Section title="burn by hour of day">
							{data.providers ? (
								<HourHeat hourly={data.providers.hourly} hues={hues} />
							) : (
								<p className="hb-uz-empty">hourly burn unavailable</p>
							)}
						</Section>
					</div>
					<Section title="models">
						<ModelLedger dashboard={data.dashboard} hues={hues} />
					</Section>
					{(data.recent?.length ?? 0) + (data.errors?.length ?? 0) > 0 && (
						<Section title="activity">
							<ActivityTail recent={data.recent ?? []} errors={data.errors ?? []} hues={hues} />
						</Section>
					)}
					{(data.dashboard.byFolder.length > 0 || (data.sessions?.length ?? 0) > 0) && (
						<Section title="projects & sessions">
							<ProjectsStrip folders={data.dashboard.byFolder} sessions={data.sessions} />
						</Section>
					)}
					<p className="hb-uz-provenance">
						sources: {[...data.sources].join(" · ")} · merged client-side for {profile === "all" ? "all profiles" : `profile ${profile}`}
					</p>
				</div>
			) : (
				<p className="hb-empty" role="status">{busy ? "Loading statistics…" : "No statistics available."}</p>
			)}
		</>
	);
}
