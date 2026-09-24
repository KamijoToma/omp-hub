/**
 * `/s/<id>` session page frame: the persistent app chrome (session rail,
 * global shortcuts, switcher dialog) plus the per-session surface.
 *
 * The frame outlives session switches — only the keyed {@link SessionView}
 * remounts, and its collab client comes warm from the pool, so switching is
 * a surface swap rather than a page reload. Session records come from the
 * shared sessions store; `starting` sessions get a per-id fast poll until
 * links appear. Once a session's surface has attached, later registry
 * updates never kick the view back to the status card (ended sessions keep
 * their transcript + banner, as before).
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getDisplayName, type SessionRecord } from "./api";
import { pushToast } from "./toasts";
import { navigate } from "./router";
import { sessionsStore, useSessionRecord } from "./sessions-store";
import { SessionRail, SessionSwitcherModal } from "./SessionRail";
import { steerPendingCount } from "./steering-queue";
import { useSessionAlerts, alertsEnabled, requestAlertPermission, setAlertsEnabled } from "./session-alerts";
import { clearCompletedSession, useCompletedSessionTracker } from "./rail-completion";
import { SessionView } from "./SessionView";

export interface SessionPageProps {
	id: string;
}

/** localStorage flag behind the rail's expanded/collapsed state (`"1"` = expanded). */
const RAIL_OPEN_KEY = "omp-hub.rail.open";

function readRailExpanded(): boolean {
	try {
		return globalThis.localStorage?.getItem(RAIL_OPEN_KEY) === "1";
	} catch {
		return false;
	}
}

function writeRailExpanded(expanded: boolean): void {
	try {
		if (expanded) globalThis.localStorage?.setItem(RAIL_OPEN_KEY, "1");
		else globalThis.localStorage?.setItem(RAIL_OPEN_KEY, "0");
	} catch {
		// persistence is best-effort; the toggle still works for this page
	}
}

/**
 * In-place gate for sessions that cannot attach yet (or no more): rendered
 * inside the frame's content column — the rail stays interactive, and no
 * full-page card swap ever flashes over the shell.
 */
function SessionStatusCard({ id, record, loadError, onHome }: { id: string; record: SessionRecord | null; loadError: string | null; onHome(): void }): ReactNode {
	return (
		<div className="hb-frame-status">
			<div className="hb-card hb-status-card">
				<div className="hb-card-title">{record?.name ?? "session"}</div>
				{record && <div className="hb-card-note hb-mono">{record.cwd}</div>}
				{record === null && loadError === null && (
					<>
						<div className="sh-connect-sub">Loading session…</div>
						<div className="hb-status-skel">
							<span className="hb-skel" />
							<span className="hb-skel" />
							<span className="hb-skel hb-skel-short" />
						</div>
					</>
				)}
				{record === null && loadError !== null && (
					<>
						<div className="hb-card-title">Session unavailable</div>
						<div className="sh-connect-error" role="alert">
							{loadError}
						</div>
						<div className="hb-card-note">the session may have been pruned, or the id is wrong</div>
						<button type="button" className="sh-btn hb-status-back" onClick={onHome}>
							Back to hub
						</button>
					</>
				)}
				{record?.status === "starting" && <div className="sh-connect-sub">Starting session…</div>}
				{record?.status === "failed" && (
					<>
						<div className="sh-connect-error" role="alert">
							{record.error ?? "start failed"}
						</div>
						<div className="hb-card-note">on {record.machineName}</div>
						<button type="button" className="sh-btn hb-status-back" onClick={onHome}>
							Back to hub
						</button>
					</>
				)}
				{record?.status === "exited" && (
					<>
						<div className="hb-card-note">exited{record.exitReason ? ` — ${record.exitReason}` : ""}</div>
						<div className="hb-card-note">on {record.machineName}</div>
						<button type="button" className="sh-btn hb-status-back" onClick={onHome}>
							Back to hub
						</button>
					</>
				)}
			</div>
			<span className="hb-mono hb-status-id">{id}</span>
		</div>
	);
}

export function SessionPage({ id }: SessionPageProps): ReactNode {
	const { record, error: loadError } = useSessionRecord(id);
	const displayName = useRef(getDisplayName()).current;

	// Attach latches: once live with links, keep the surface mounted for this
	// id even if later polls flip the registry status (ended keeps its banner).
	// Display-relevant record fields still flow through (rename, cwd).
	const [live, setLive] = useState<SessionRecord | null>(null);
	useEffect(() => {
		setLive(null);
	}, [id]);
	useEffect(() => {
		if (record === null || record.status !== "live" || record.links === undefined) return;
		setLive(previous => {
			if (
				previous !== null &&
				previous.id === record.id &&
				previous.name === record.name &&
				previous.cwd === record.cwd &&
				previous.profile === record.profile &&
				previous.machineId === record.machineId
			) {
				return previous;
			}
			return record;
		});
	}, [record]);

	// Unknown id: fetch its detail immediately; `starting`: fast-poll until links.
	useEffect(() => {
		if (record === null && loadError === null) void sessionsStore.refreshSession(id);
	}, [id, record, loadError]);
	useEffect(() => {
		if (record?.status !== "starting") return;
		const timer = setInterval(() => void sessionsStore.refreshSession(id), 1000);
		return () => clearInterval(timer);
	}, [id, record?.status]);

	// Rail state (expanded vs icon strip) persists across switches by design.
	const [railExpanded, setRailExpanded] = useState(readRailExpanded);
	const toggleRailExpanded = useCallback((): void => {
		setRailExpanded(previous => {
			writeRailExpanded(!previous);
			return !previous;
		});
	}, []);

	// Ctrl+K opens the quick switcher from anywhere on the page, in capture
	// phase so it wins against the composer palette. Esc collapses the expanded
	// rail — unless the switcher modal (or a surface dialog) owns the key.
	const [switcherOpen, setSwitcherOpen] = useState(false);
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
				e.preventDefault();
				e.stopPropagation();
				setSwitcherOpen(true);
				return;
			}
			if (e.key === "Escape" && !switcherOpen && railExpanded) {
				// A surface dialog's own Esc handling wins; don't also fold the rail.
				if (document.querySelector(".hb-modal-backdrop")) return;
				e.preventDefault();
				e.stopPropagation();
				toggleRailExpanded();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [switcherOpen, railExpanded, toggleRailExpanded]);

	const switchSession = useCallback(
		(nextId: string): void => {
			if (nextId === id) {
				setSwitcherOpen(false);
				return;
			}
			if (steerPendingCount(id) > 0) {
				pushToast("warning", "switching away drops queued steering messages");
			}
			setSwitcherOpen(false);
			navigate(`/s/${nextId}`);
		},
		[id],
	);
	const leave = useCallback((): void => navigate("/"), []);

	// Local "task completed" markers: track working→idle edges registry-wide,
	// and treat the session on screen as visited (its marker resets to idle).
	useCompletedSessionTracker(id);
	useEffect(() => clearCompletedSession(id), [id]);

	// Cross-session alerts off the shared registry poll (bell lives in the rail).
	const [alertsOn, setAlertsOn] = useState(alertsEnabled);
	const toggleAlerts = useCallback((): void => {
		const next = !alertsOn;
		setAlertsEnabled(next);
		setAlertsOn(next);
		if (!next) return;
		void requestAlertPermission().then(permission => {
			if (permission === "granted") pushToast("info", "session alerts on");
			else if (permission === "unsupported") pushToast("warning", "alerts on — no notification support here, using toasts");
			else pushToast("warning", "alerts on — notifications blocked, using toasts and the tab title");
		});
	}, [alertsOn]);
	useSessionAlerts({ enabled: alertsOn, currentId: id, notify: pushToast });

	return (
		<div className="hb-frame">
			<SessionRail
				currentId={id}
				expanded={railExpanded}
				onToggleExpanded={toggleRailExpanded}
				onHome={leave}
				onSwitch={switchSession}
				alertsOn={alertsOn}
				onToggleAlerts={toggleAlerts}
			/>
			<div className="hb-frame-main">
				{live !== null && live.links ? (
					<SessionView
						key={id}
						sessionId={id}
						link={live.links.full}
						record={live}
						displayName={displayName}
						registryLive={record?.status === "live"}
						onLeave={leave}
						onOpenSwitcher={() => setSwitcherOpen(true)}
					/>
				) : (
					<SessionStatusCard id={id} record={record} loadError={loadError} onHome={leave} />
				)}
			</div>
			{switcherOpen && <SessionSwitcherModal currentId={id} onSwitch={switchSession} onClose={() => setSwitcherOpen(false)} />}
		</div>
	);
}
