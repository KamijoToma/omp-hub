/**
 * Authenticated omp-hub settings center. Browser preferences are available
 * everywhere in the hub; agent controls mount only for a live session.
 */
import { ArrowLeft, LoaderCircle, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Notice } from "../lib/client";
import { useThemePreference, type ThemePreference } from "../lib/theme";
import { STATS_METRICS, toggleStatsMetric, useStatsPrefs } from "../lib/stats-prefs";
import { DEFAULT_DISPLAY_NAME, getDisplayName, setDisplayName, type SessionRecord } from "./api";
import { AdvancedSettings } from "./AdvancedSettings";
import { showAllSessions, useHiddenSessions } from "./hidden-sessions";
import { LinksSection } from "./LinksModal";
import { Modal } from "./Modal";
import { ModelPickerView } from "./ModelPicker";
import { setShowEnded, useShowEnded } from "./rail-filter";
import {
	notificationPermission,
	requestAlertPermission,
	setAlertsEnabled,
	setCompletionsEnabled,
	useAlertsEnabled,
	useCompletionsEnabled,
} from "./session-alerts";
import { setSessionTimeMode, useSessionTimeMode } from "./session-time-mode";
import { useSessionRecord } from "./sessions-store";
import { ThinkingPickerView } from "./ThinkingPicker";
import { useAgentState } from "./use-agent-state";

export interface SettingsModalProps {
	sessionId?: string;
	initialSection: "browser" | "session";
	notify(level: Notice["level"], message: string): void;
	onLogout(): void;
	onClose(): void;
}

type SettingsView = "browser" | "session" | "model" | "thinking" | "advanced";

const VIEW_TITLE: Record<SettingsView, string> = {
	browser: "omp-hub settings",
	session: "omp-hub settings",
	model: "Model",
	thinking: "Thinking",
	advanced: "Advanced",
};

const PERMISSION_NOTES: Record<NotificationPermission | "unsupported", string> = {
	granted: "desktop notifications can appear while you view another page or tab",
	default: "your browser asks for permission when you enable notifications",
	denied: "blocked by this browser — toasts and the tab title flash instead",
	unsupported: "this browser has no notification support — toasts only",
};

/** The existing session pickers and runtime overrides stay session-scoped. */
function SessionSettings({
	record,
	view,
	setView,
	notify,
	onClose,
}: {
	record: SessionRecord;
	view: SettingsView;
	setView(view: SettingsView): void;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}): ReactNode {
	const load = useAgentState(record.id);
	if (view === "model") return <ModelPickerView load={load} sessionId={record.id} notify={notify} onClose={onClose} />;
	if (view === "thinking") return <ThinkingPickerView load={load} sessionId={record.id} notify={notify} onClose={onClose} />;
	if (view === "advanced") return <AdvancedSettings sessionId={record.id} notify={notify} />;
	const busy = load.loading && !load.state;
	const failed = load.error !== null && !load.state;

	return (
		<>
			<p className="hb-card-note">Current session · {record.name} on {record.machineName}</p>
			<section className="hb-modal-section">
				<h3 className="hb-card-title">Model</h3>
				<div className="hb-modal-row">
					<span className="hb-modal-value">
						{busy ? <><LoaderCircle size={12} className="hb-spin" aria-hidden="true" /> loading…</> : (load.state?.model?.name ?? "not reported")}
					</span>
					<button type="button" className="sh-btn" onClick={() => setView("model")} disabled={failed}>Change</button>
				</div>
			</section>
			<section className="hb-modal-section">
				<h3 className="hb-card-title">Thinking</h3>
				<div className="hb-modal-row">
					<span className="hb-modal-value">
						{busy ? <><LoaderCircle size={12} className="hb-spin" aria-hidden="true" /> loading…</> : (load.state?.thinkingLevel ?? "not reported")}
					</span>
					<button type="button" className="sh-btn" onClick={() => setView("thinking")} disabled={failed}>Change</button>
				</div>
			</section>
			<section className="hb-modal-section">
				<h3 className="hb-card-title">Advanced</h3>
				<div className="hb-modal-row">
					<span className="hb-modal-value">Runtime overrides for this session only; never saved to settings.json.</span>
					<button type="button" className="sh-btn" onClick={() => setView("advanced")}>Open</button>
				</div>
			</section>
			{load.error && <div className="hb-modal-error" role="alert">{load.error}</div>}
			<section className="hb-modal-section">
				<h3 className="hb-card-title">Connection links</h3>
				<LinksSection record={record} />
			</section>
		</>
	);
}

export function SettingsModal({ sessionId, initialSection, notify, onLogout, onClose }: SettingsModalProps): ReactNode {
	const [view, setView] = useState<SettingsView>(initialSection);
	const { record } = useSessionRecord(sessionId ?? "");
	const liveRecord = record?.status === "live" ? record : null;
	const { preference, resolved, setPreference } = useThemePreference();
	const alertsOn = useAlertsEnabled();
	const completionsOn = useCompletionsEnabled();
	const [permission, setPermission] = useState(notificationPermission);
	const [name, setName] = useState(getDisplayName);
	const [savedName, setSavedName] = useState<string | null>(null);
	const showEnded = useShowEnded();
	const timeMode = useSessionTimeMode();
	const hidden = useHiddenSessions();
	const visibleStats = useStatsPrefs();
	const subview = view === "model" || view === "thinking" || view === "advanced";

	const toggleNotification = (kind: "alerts" | "completions"): void => {
		const enabled = kind === "alerts" ? !alertsOn : !completionsOn;
		if (kind === "alerts") setAlertsEnabled(enabled);
		else setCompletionsEnabled(enabled);
		if (!enabled) return;
		void requestAlertPermission().then(granted => {
			setPermission(granted);
			if (granted !== "granted") notify("warning", PERMISSION_NOTES[granted]);
		});
	};

	return (
		<Modal
			title={VIEW_TITLE[view]}
			onClose={onClose}
			leading={subview ? (
				<button type="button" className="sh-btn" onClick={() => setView("session")} title="back to session settings" aria-label="back to session settings">
					<ArrowLeft size={13} aria-hidden="true" />
				</button>
			) : undefined}
		>
			{!subview && (
				<div className="hb-settings-tabs" role="group" aria-label="settings scope">
					<button type="button" aria-pressed={view === "browser"} className={view === "browser" ? "sh-btn sh-btn-on" : "sh-btn"} onClick={() => setView("browser")}>
						This browser
					</button>
					{sessionId && (
						<button type="button" aria-pressed={view === "session"} className={view === "session" ? "sh-btn sh-btn-on" : "sh-btn"} onClick={() => setView("session")}>
							Current session
						</button>
					)}
				</div>
			)}
			{view === "browser" ? (
				<>
					<p className="hb-card-note">These preferences are stored in this browser, not on the hub or other devices.</p>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Appearance</h3>
						<label className="hb-settings-field">
							<span className="hb-modal-value">Theme · currently {resolved}</span>
							<select className="sh-input" value={preference} onChange={e => setPreference(e.target.value as ThemePreference)} aria-label="theme">
								<option value="system">System</option>
								<option value="light">Light</option>
								<option value="dark">Dark</option>
							</select>
						</label>
					</section>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Notifications</h3>
						<label className="hb-settings-choice">
							<input type="checkbox" checked={alertsOn} onChange={() => toggleNotification("alerts")} />
							<span>Needs input or session exits</span>
						</label>
						<label className="hb-settings-choice">
							<input type="checkbox" checked={completionsOn} onChange={() => toggleNotification("completions")} />
							<span>Agent finishes a task</span>
						</label>
						<p className="hb-card-note">{PERMISSION_NOTES[permission]}</p>
					</section>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Display name</h3>
						<div className="hb-modal-row hb-settings-name">
							<input className="sh-input" value={name} onChange={e => setName(e.target.value)} placeholder={DEFAULT_DISPLAY_NAME} maxLength={32} aria-label="display name" spellCheck={false} autoComplete="off" />
							<button type="button" className="sh-btn" onClick={() => { setDisplayName(name); setSavedName(name.trim() || DEFAULT_DISPLAY_NAME); }}>Save</button>
						</div>
						<p className="hb-card-note">{savedName ? `Saved as “${savedName}”. ` : ""}Applies on the next connection; existing guests keep their name.</p>
					</section>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Session list</h3>
						<label className="hb-settings-field">
							<span className="hb-modal-value">Timestamp</span>
							<select className="sh-input" value={timeMode} onChange={e => setSessionTimeMode(e.target.value === "activity" ? "activity" : "created")} aria-label="session timestamps">
								<option value="created">Created</option>
								<option value="activity">Last activity</option>
							</select>
						</label>
						<label className="hb-settings-choice">
							<input type="checkbox" checked={showEnded} onChange={e => setShowEnded(e.target.checked)} />
							<span>Show ended sessions in the Sessions list</span>
						</label>
						<div className="hb-modal-row">
							<span className="hb-modal-value">{hidden.size} hidden session{hidden.size === 1 ? "" : "s"} in this browser</span>
							<button type="button" className="sh-btn" disabled={hidden.size === 0} onClick={showAllSessions}>Show all</button>
						</div>
					</section>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Session stats bar</h3>
						<p className="hb-card-note">Choose the metrics shown beneath the session header (also applies to /join).</p>
						<div className="hb-settings-stats">
							{STATS_METRICS.map(metric => (
								<label key={metric.id} className="hb-settings-choice" title={metric.description}>
									<input type="checkbox" checked={visibleStats.has(metric.id)} onChange={() => toggleStatsMetric(metric.id)} />
									<span>{metric.label}</span>
								</label>
							))}
						</div>
					</section>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Access</h3>
						<div className="hb-modal-row">
							<span className="hb-modal-value">Log out of this browser. The hub token remains unchanged on the server.</span>
							<button type="button" className="sh-btn" onClick={onLogout}><LogOut size={13} aria-hidden="true" /> Log out</button>
						</div>
					</section>
				</>
			) : liveRecord ? (
				<SessionSettings record={liveRecord} view={view} setView={setView} notify={notify} onClose={onClose} />
			) : (
				<p className="hb-card-note">Session settings are available only while this session is live.</p>
			)}
		</Modal>
	);
}
