/**
 * Machine usage: historical statistics and live subscription quotas for one
 * selected profile (or a merged report across every profile). The panels
 * themselves live in `usage/` — this file owns the header, the profile and
 * range selectors, and the tab switch.
 */
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { MachineRecord, UsageRange } from "./api";
import { getMachines, listMachineProfiles } from "./api";
import { navigate } from "./router";
import { StatisticsPanel } from "./usage/StatisticsPanel";
import { SubscriptionsPanel } from "./usage/SubscriptionsPanel";

const MACHINE_POLL_MS = 2000;

/** Where the last profile selection persists across page visits. */
const PROFILE_KEY = "omp-hub.usage.profile";

/** Selection values: `"all"` (merged report), `"default"`, or a named profile. */
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
					profile={profile === "default" ? "default" : profile}
					profiles={profiles ?? []}
					range={range}
				/>
			) : profiles === null || (profile !== "default" && profile !== "all" && !profiles.includes(profile)) || (profile === "all" && profiles.length === 0) ? (
				<p className="hb-empty" role="status">Loading profiles…</p>
			) : (
				<SubscriptionsPanel
					key={`${machineId}:${profile}:${profiles?.join("\u0000") ?? ""}`}
					machineId={machineId}
					profile={profile}
				/>
			)}
		</div>
	);
}
