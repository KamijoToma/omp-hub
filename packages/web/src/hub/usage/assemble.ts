/**
 * Statistics-tab view-model assembly: takes the per-profile fulfilled relay
 * payloads (any subset — sections degrade independently) and produces the
 * merged data the components render. Pure so the "all profiles" merge and
 * the single-profile pass share one tested code path.
 */
import type {
	MachineDashboardStats,
	MachineProviderUsage,
	UsageRecentRequest,
	UsageSessionSummary,
} from "../api";
import {
	mergeModelDashboards,
	mergeProviderUsage,
	mergeRecentRequests,
	mergeSessionSummaries,
} from "../usage-merge";

/** The relay calls behind the Statistics tab; any of them may fail alone. */
export interface StatisticsParts {
	dashboard: MachineDashboardStats | null;
	providers: MachineProviderUsage | null;
	recent: UsageRecentRequest[] | null;
	errors: UsageRecentRequest[] | null;
	sessions: UsageSessionSummary[] | null;
}

/** Merged per-type payloads plus how many relay calls failed outright. */
export interface AssembledStatistics extends StatisticsParts {
	/** Count of failed relay calls across all profiles and types. */
	failedCalls: number;
	/** Relay paths that answered for at least one profile (provenance footer). */
	sources: string[];
}

/**
 * Merges one entry per profile (already filtered to fulfilled promises).
 * `dashboard` is the backbone: when it failed for every profile the tab has
 * nothing to show and the caller keeps its previous data.
 */
export function assembleStatistics(perProfile: readonly StatisticsParts[]): AssembledStatistics {
	let failedCalls = 0;
	const dashboards: MachineDashboardStats[] = [];
	const providerParts: MachineProviderUsage[] = [];
	const recents: UsageRecentRequest[][] = [];
	const errorParts: UsageRecentRequest[][] = [];
	const sessionParts: UsageSessionSummary[][] = [];
	const sources = new Set<string>();

	for (const part of perProfile) {
		if (part.dashboard) {
			dashboards.push(part.dashboard);
			sources.add("api/stats/model-dashboard");
		} else failedCalls++;
		if (part.providers) {
			providerParts.push(part.providers);
			sources.add("api/stats/providers");
		} else failedCalls++;
		if (part.recent) {
			recents.push(part.recent);
			sources.add("api/stats/recent");
		} else failedCalls++;
		if (part.errors) {
			errorParts.push(part.errors);
			sources.add("api/stats/errors");
		} else failedCalls++;
		if (part.sessions) {
			sessionParts.push(part.sessions);
			sources.add("api/sessions");
		} else failedCalls++;
	}

	const RECENT_CAP = 8;
	return {
		dashboard: dashboards.length > 0 ? mergeModelDashboards(dashboards) : null,
		providers: providerParts.length > 0 ? mergeProviderUsage(providerParts) : null,
		recent: recents.length > 0 ? mergeRecentRequests(recents, RECENT_CAP) : null,
		errors: errorParts.length > 0 ? mergeRecentRequests(errorParts, RECENT_CAP) : null,
		sessions: sessionParts.length > 0 ? mergeSessionSummaries(sessionParts) : null,
		failedCalls,
		sources: [...sources].sort(),
	};
}
