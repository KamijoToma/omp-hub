/**
 * Subscriptions tab: live quota snapshot for the selected profile (the "all"
 * view deliberately shows the default profile only — a snapshot spawns an
 * isolated worker and hits provider APIs, so it never fans out per profile),
 * joined with the dashboard's window insights and per-provider burn-down
 * history. Snapshot failures keep the previous data on screen.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
	errorText,
	getMachineProviderWindows,
	getMachineSubscriptions,
	type SubscriptionUsage,
	type UsageWindowInsight,
	type UsageWindowSeries,
} from "../api";
import { BurnDownLanes } from "./BurnDownLanes";
import { CalloutBar, FleetStrip } from "./FleetStrip";
import { QuotaMatrix } from "./QuotaMatrix";
import { ResetRail } from "./ResetRail";
import { WindowCapacity } from "./WindowCapacity";

function ok<T>(result: PromiseSettledResult<T>): T | null {
	return result.status === "fulfilled" ? result.value : null;
}

export function SubscriptionsPanel({ machineId, profile }: { machineId: string; profile: string }): ReactNode {
	const [usage, setUsage] = useState<SubscriptionUsage | null>(null);
	const [insights, setInsights] = useState<UsageWindowInsight[]>([]);
	const [lanes, setLanes] = useState<UsageWindowSeries[] | null>(null);
	const [lanesAvailable, setLanesAvailable] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			// "all profiles" reads the default profile's live quotas and says so.
			const target = profile === "all" ? "default" : profile;
			const [subsResult, baseWindows] = await Promise.allSettled([
				getMachineSubscriptions(machineId, target),
				getMachineProviderWindows(machineId),
			]);

			const snapshot = ok(subsResult);
			if (snapshot !== null) setUsage(snapshot);
			else setError(errorText((subsResult as PromiseRejectedResult).reason));

			const insightRows = ok(baseWindows)?.windowInsights ?? [];
			setInsights(insightRows);

			// Batch 2: burn-down series per provider (only fetched with a provider filter).
			const providerSet = new Set<string>();
			for (const report of snapshot?.reports ?? []) providerSet.add(report.provider);
			for (const insight of insightRows) providerSet.add(insight.provider);
			if (providerSet.size === 0) {
				setLanes([]);
				setLanesAvailable(true);
			} else {
				const laneResults = await Promise.allSettled([...providerSet].map(provider => getMachineProviderWindows(machineId, provider)));
				const byKey = new Map<string, UsageWindowSeries>();
				let anyAnswered = false;
				for (const result of laneResults) {
					const payload = ok(result);
					if (payload === null) continue;
					anyAnswered = true;
					for (const series of payload.usageSeries) byKey.set(`${series.provider}:${series.accountKey}:${series.windowKey}`, series);
				}
				setLanesAvailable(anyAnswered);
				setLanes([...byKey.values()]);
			}
		} finally {
			setBusy(false);
		}
	}, [machineId, profile]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<>
			<div className="hb-usage-controls">
				<p className="hb-card-note">Live subscription quotas for this machine, separate from historical statistics.</p>
				<button type="button" className="sh-btn" onClick={() => void load()} disabled={busy}>
					<span className="sh-btn-label">{busy ? "loading…" : "Refresh"}</span>
				</button>
			</div>
			{profile === "all" && (
				<p className="hb-usage-feedback" role="status">
					Live quotas are shown for the default profile — snapshots hit provider APIs, so pick a profile for its accounts.
				</p>
			)}
			{busy && usage !== null && <p className="hb-usage-feedback" role="status">Refreshing subscriptions; showing previous data.</p>}
			{error && <div className="hb-banner" role="alert">{error}{usage !== null && " — showing previously fetched data."}</div>}
			{usage === null ? (
				<p className="hb-empty" role="status">{busy ? "Loading subscriptions…" : "No subscription data available."}</p>
			) : (
				<div className="hb-uz-tab">
					<FleetStrip usage={usage} insights={insights} />
					<CalloutBar insights={insights} />
					<ResetRail usage={usage} />
					<QuotaMatrix usage={usage} />
					{lanesAvailable ? lanes !== null && lanes.length > 0 && (
						<section className="hb-uz-section">
							<h3 className="hb-uz-sec-title">burn-down history</h3>
							<BurnDownLanes series={lanes} />
						</section>
					) : (
						<section className="hb-uz-section">
							<h3 className="hb-uz-sec-title">burn-down history</h3>
							<p className="hb-uz-empty">window history unavailable</p>
						</section>
					)}
					{insights.length > 0 && (
						<section className="hb-uz-section">
							<h3 className="hb-uz-sec-title">window capacity</h3>
							<WindowCapacity insights={insights} />
						</section>
					)}
					<p className="hb-uz-provenance">sources: api/subscriptions · api/stats/provider-windows</p>
				</div>
			)}
		</>
	);
}
