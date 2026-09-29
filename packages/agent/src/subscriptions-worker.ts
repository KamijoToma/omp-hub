import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	accountIdentityLabel,
	collectStoredAccounts,
	collectUnreportedAccounts,
	selectReportableAccounts,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-accounts";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";

export interface SubscriptionLimit {
	id: string;
	label: string;
	amount: { unit: string; used?: number; limit?: number; remaining?: number; usedFraction?: number; remainingFraction?: number };
	window?: { id: string; label: string; durationMs?: number; resetsAt?: number; resetLabel?: string };
	status?: string;
	notes?: string[];
}

export interface SubscriptionReport {
	provider: string;
	account: string;
	fetchedAt: number;
	limits: SubscriptionLimit[];
	resetCredits?: { availableCount: number; redeemableCount?: number };
}

export interface SubscriptionUsage {
	fetchedAt: number;
	reports: SubscriptionReport[];
	unavailable: Array<{ provider: string; account: string }>;
}

function projectLimit(limit: UsageLimit): SubscriptionLimit {
	const { amount, window } = limit;
	return {
		id: limit.id,
		label: limit.label,
		amount: {
			unit: amount.unit,
			...(amount.used !== undefined ? { used: amount.used } : {}),
			...(amount.limit !== undefined ? { limit: amount.limit } : {}),
			...(amount.remaining !== undefined ? { remaining: amount.remaining } : {}),
			...(amount.usedFraction !== undefined ? { usedFraction: amount.usedFraction } : {}),
			...(amount.remainingFraction !== undefined ? { remainingFraction: amount.remainingFraction } : {}),
		},
		...(window ? { window: {
			id: window.id,
			label: window.label,
			...(window.durationMs !== undefined ? { durationMs: window.durationMs } : {}),
			...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
			...(window.resetLabel !== undefined ? { resetLabel: window.resetLabel } : {}),
		} } : {}),
		...(limit.status !== undefined ? { status: limit.status } : {}),
		...(limit.notes !== undefined ? { notes: limit.notes } : {}),
	};
}

/** Explicitly allowlist quota fields: SDK metadata, scopes, raw response and credentials never cross the wire. */
export function projectSubscriptions(
	reports: UsageReport[],
	unavailable: Array<{ provider: string; account: string }>,
	fetchedAt: number,
): SubscriptionUsage {
	const indices = new Map<string, number>();
	return {
		fetchedAt,
		reports: reports.map(report => {
			const index = indices.get(report.provider) ?? 0;
			indices.set(report.provider, index + 1);
			const metadata = report.metadata ?? {};
			const base = [metadata.email, metadata.accountId, metadata.projectId]
				.find((value): value is string => typeof value === "string" && value.length > 0)
				?? report.limits.map(limit => limit.scope.accountId ?? limit.scope.projectId).find(Boolean)
				?? `account ${index + 1}`;
			const org = typeof metadata.orgName === "string" && metadata.orgName ? metadata.orgName
				: typeof metadata.orgId === "string" && metadata.orgId ? metadata.orgId : undefined;
			return {
				provider: report.provider,
				account: org && org !== base ? `${base} · ${org}` : base,
				fetchedAt: report.fetchedAt,
				limits: report.limits.map(projectLimit),
				...(report.resetCredits ? { resetCredits: {
					availableCount: report.resetCredits.availableCount,
					...(report.resetCredits.redeemableCount !== undefined ? { redeemableCount: report.resetCredits.redeemableCount } : {}),
				} } : {}),
			};
		}),
		unavailable: unavailable.map(({ provider, account }) => ({ provider, account })),
	};
}

/** Run in a fresh process: pi-utils resolves profile directories when SDK modules load. */
export async function fetchSubscriptions(): Promise<SubscriptionUsage> {
	const settings = await Settings.loadReadOnly();
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, getProjectDir(), {
			includeAmbientHooks: false,
			discoverModels: false,
		});
		try {
			await authStorage.credentials.revalidate();
		} catch {
			// Same as omp usage: a broker outage must not hide the local credential snapshot.
		}
		const reports = (await authStorage.usage.reports({
			baseUrlResolver: provider => modelRegistry.getProviderBaseUrl(provider),
		})) ?? [];
		const accounts = selectReportableAccounts(
			collectStoredAccounts(authStorage),
			provider => authStorage.usage.providerFor(provider) !== undefined,
		);
		const unavailable = collectUnreportedAccounts(reports, accounts).map(account => ({
			provider: account.provider,
			account: accountIdentityLabel(account),
		}));
		return projectSubscriptions(reports, unavailable, Date.now());
	} finally {
		authStorage.close();
	}
}

if (import.meta.main) {
	fetchSubscriptions()
		.then(usage => process.stdout.write(JSON.stringify(usage), () => process.exit(0)))
		.catch(() => {
			// SDK errors can contain provider responses and credentials. Never echo them to stderr or the hub.
			process.exit(1);
		});
}
