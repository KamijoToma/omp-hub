import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { SessionRecord } from "./api";
import { HomePage } from "./HomePage";
import { useHiddenSessions } from "./hidden-sessions";
import { clearCompletedSession, useCompletedSessionTracker } from "./rail-completion";
import { pickFallbackSessionId } from "./rail-filter";
import { navigate } from "./router";
import { SessionPage } from "./SessionPage";
import { SessionRail, SessionSwitcherModal } from "./SessionRail";
import { requestAlertPermission, setAlertsEnabled, useAlertsEnabled } from "./session-alerts";
import { sessionsStore } from "./sessions-store";
import { steerPendingCount } from "./steering-queue";
import { pushToast } from "./toasts";

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
		else globalThis.localStorage?.removeItem(RAIL_OPEN_KEY);
	} catch {
		// Persistence is best-effort; the toggle still works for this page.
	}
}

export interface HubFrameProps {
	/** `null` selects the pinned New tab (`/`). */
	id: string | null;
	onLogout(): void;
	onOpenSettings(section: "browser" | "session"): void;
}

/** Rail and shortcuts persist across `/` and `/s/<id>`; only the content pane changes. */
export function HubFrame({ id, onLogout, onOpenSettings }: HubFrameProps): ReactNode {
	const [railExpanded, setRailExpanded] = useState(readRailExpanded);
	const toggleRailExpanded = useCallback((): void => {
		setRailExpanded(previous => {
			writeRailExpanded(!previous);
			return !previous;
		});
	}, []);

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
				if (document.querySelector(".hb-modal-backdrop")) return;
				e.preventDefault();
				e.stopPropagation();
				toggleRailExpanded();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [switcherOpen, railExpanded, toggleRailExpanded]);

	const warnPending = useCallback((): void => {
		if (id !== null && steerPendingCount(id) > 0) {
			pushToast("warning", "switching away drops queued steering messages");
		}
	}, [id]);
	const switchSession = useCallback((nextId: string): void => {
		setSwitcherOpen(false);
		if (nextId === id) return;
		warnPending();
		navigate(`/s/${nextId}`);
	}, [id, warnPending]);
	const openNew = useCallback((): void => {
		setSwitcherOpen(false);
		if (id === null) return;
		warnPending();
		navigate("/");
	}, [id, warnPending]);

	// The registry has already forgotten this row when the callback runs.
	// Replace the dead URL with another visible session, or the pinned New tab.
	const hidden = useHiddenSessions();
	const handleDeleted = useCallback((session: SessionRecord): void => {
		if (id === null || session.id !== id) return;
		setSwitcherOpen(false);
		const next = pickFallbackSessionId(id, sessionsStore.getSnapshot().sessions, hidden);
		navigate(next === null ? "/" : `/s/${next}`, true);
	}, [id, hidden]);

	// The New tab has no visited session; completions there remain visible in the rail.
	useCompletedSessionTracker(id ?? "");
	useEffect(() => {
		if (id !== null) clearCompletedSession(id);
	}, [id]);

	const alertsOn = useAlertsEnabled();
	const toggleAlerts = useCallback((): void => {
		const next = !alertsOn;
		setAlertsEnabled(next);
		if (!next) return;
		void requestAlertPermission().then(permission => {
			if (permission === "granted") pushToast("info", "session alerts on");
			else if (permission === "unsupported") pushToast("warning", "alerts on — no notification support here, using toasts");
			else pushToast("warning", "alerts on — notifications blocked, using toasts and the tab title");
		});
	}, [alertsOn]);

	return (
		<div className="hb-frame">
			<SessionRail
				currentId={id}
				expanded={railExpanded}
				onToggleExpanded={toggleRailExpanded}
				onNew={openNew}
				onSwitch={switchSession}
				onDeleted={handleDeleted}
				alertsOn={alertsOn}
				onToggleAlerts={toggleAlerts}
				onOpenSettings={() => onOpenSettings("browser")}
			/>
			<div className="hb-frame-main">
				{id === null ? (
					<HomePage onLogout={onLogout} onOpenSettings={() => onOpenSettings("browser")} />
				) : (
					<SessionPage key={id} id={id} onLeave={openNew} onOpenSwitcher={() => setSwitcherOpen(true)} onOpenSettings={() => onOpenSettings("session")} />
				)}
			</div>
			{switcherOpen && (
				<SessionSwitcherModal
					currentId={id}
					onSwitch={switchSession}
					onOpenSettings={() => {
						setSwitcherOpen(false);
						onOpenSettings("browser");
					}}
					onClose={() => setSwitcherOpen(false)}
					onDeleted={handleDeleted}
				/>
			)}
		</div>
	);
}
