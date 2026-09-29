/**
 * `/settings` — one dialog for model, thinking, collab links, theme, the
 * display name, and completion notifications. Model and thinking swap the
 * body to the shared picker views (back arrow in the header returns); links
 * reuse `LinksSection`.
 *
 * Display name is stored in `omp-hub.name` (docs/protocol.md §5) and only
 * reaches the relay handshake on the next connection.
 */
import { ArrowLeft, Bell, BellOff, LoaderCircle, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Notice } from "../lib/client";
import type { SystemTheme, ThemePreference } from "../lib/theme";
import type { SessionRecord } from "./api";
import { DEFAULT_DISPLAY_NAME, getDisplayName, setDisplayName } from "./api";
import { LinksSection } from "./LinksModal";
import { Modal } from "./Modal";
import { ModelPickerView } from "./ModelPicker";
import { notificationPermission, requestAlertPermission, setCompletionsEnabled, useCompletionsEnabled } from "./session-alerts";
import { ThinkingPickerView } from "./ThinkingPicker";
import { useAgentState } from "./use-agent-state";
import { AdvancedSettings } from "./AdvancedSettings";

/** Vendored theme store handles (see `src/lib/theme.ts`). */
export interface ThemeControls {
	preference: ThemePreference;
	resolved: SystemTheme;
	setPreference(preference: ThemePreference): void;
}

export interface SettingsModalProps {
	sessionId: string;
	record: SessionRecord | null;
	theme: ThemeControls;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

type SettingsView = "main" | "model" | "thinking" | "advanced";

const VIEW_TITLE: Record<SettingsView, string> = {
	main: "Settings",
	model: "Model",
	thinking: "Thinking",
	advanced: "Advanced",
};

/** One-line explanation of the browser notification permission for the dialog. */
const PERMISSION_NOTES: Record<NotificationPermission | "unsupported", string> = {
	granted: "desktop notifications fire while the hub tab is hidden or showing another session",
	default: "the browser asks for permission the first time you enable",
	denied: "notifications are blocked in this browser — toasts and the tab title flash instead",
	unsupported: "this browser has no notification support — toasts only",
};

export function SettingsModal({ sessionId, record, theme, notify, onClose }: SettingsModalProps): ReactNode {
	const load = useAgentState(sessionId);
	const [view, setView] = useState<SettingsView>("main");
	const [name, setName] = useState(() => getDisplayName());
	const [savedName, setSavedName] = useState<string | null>(null);
	// Completion notifications: own toggle plus the browser permission it needs.
	const completionsOn = useCompletionsEnabled();
	const [permission, setPermission] = useState(notificationPermission);

	const toggleCompletions = (): void => {
		if (completionsOn) {
			setCompletionsEnabled(false);
			return;
		}
		setCompletionsEnabled(true);
		void requestAlertPermission().then(granted => {
			setPermission(granted);
			if (granted === "granted") notify("info", "completion notifications on");
			else if (granted === "unsupported") notify("warning", "completion notices on — no notification support here, toasts only");
			else notify("warning", "completion notices on — notifications blocked, toasts only");
		});
	};

	const busy = load.loading && !load.state;
	const failed = load.error !== null && !load.state;

	return (
		<Modal
			title={VIEW_TITLE[view]}
			onClose={onClose}
			leading={
				view === "main" ? undefined : (
					<button type="button" className="sh-btn" onClick={() => setView("main")} title="back to settings">
						<ArrowLeft size={13} aria-hidden="true" />
					</button>
				)
			}
		>
			{view === "model" ? (
				<ModelPickerView load={load} sessionId={sessionId} notify={notify} onClose={onClose} />
			) : view === "thinking" ? (
				<ThinkingPickerView load={load} sessionId={sessionId} notify={notify} onClose={onClose} />
			) : view === "advanced" ? (
				<AdvancedSettings sessionId={sessionId} notify={notify} />
			) : (
				<>
					<section className="hb-modal-section">
						<h3 className="hb-card-title">Model</h3>
						<div className="hb-modal-row">
							<span className="hb-modal-value">
								{busy ? (
									<>
										<LoaderCircle size={12} className="hb-spin" aria-hidden="true" /> loading…
									</>
								) : (
									(load.state?.model?.name ?? "not reported")
								)}
							</span>
							<button type="button" className="sh-btn" onClick={() => setView("model")} disabled={failed}>
								Change
							</button>
						</div>
					</section>

					<section className="hb-modal-section">
						<h3 className="hb-card-title">Thinking</h3>
						<div className="hb-modal-row">
							<span className="hb-modal-value">
								{busy ? (
									<>
										<LoaderCircle size={12} className="hb-spin" aria-hidden="true" /> loading…
									</>
								) : (
									(load.state?.thinkingLevel ?? "not reported")
								)}
							</span>
							<button type="button" className="sh-btn" onClick={() => setView("thinking")} disabled={failed}>
								Change
							</button>
						</div>
					</section>

					<section className="hb-modal-section">
						<h3 className="hb-card-title">Advanced</h3>
						<div className="hb-modal-row">
							<span className="hb-modal-value">session settings — runtime overrides, not persisted</span>
							<button type="button" className="sh-btn" onClick={() => setView("advanced")}>
								Open
							</button>
						</div>
					</section>

					{load.error && (
						<div className="hb-modal-error" role="alert">
							{load.error}
						</div>
					)}

					<section className="hb-modal-section">
						<h3 className="hb-card-title">Links</h3>
						<LinksSection record={record} />
					</section>

					<section className="hb-modal-section">
						<h3 className="hb-card-title">Appearance</h3>
						<div className="hb-modal-row">
							<span className="hb-modal-value">
								{theme.preference} · currently {theme.resolved}
							</span>
							<button
								type="button"
								className="sh-btn"
								onClick={() => theme.setPreference(theme.resolved === "dark" ? "light" : "dark")}
							>
								{theme.resolved === "dark" ? <Sun size={12} aria-hidden="true" /> : <Moon size={12} aria-hidden="true" />}
								<span className="sh-btn-label">Use {theme.resolved === "dark" ? "light" : "dark"}</span>
							</button>
						</div>
					</section>

					<section className="hb-modal-section">
						<h3 className="hb-card-title">Notifications</h3>
						<div className="hb-modal-row">
							<span className="hb-modal-value">
								{completionsOn ? "on · notify when the agent finishes a task" : "off"}
							</span>
							<button type="button" className="sh-btn" onClick={toggleCompletions} title="toggle completion notifications">
								{completionsOn ? <BellOff size={12} aria-hidden="true" /> : <Bell size={12} aria-hidden="true" />}
								<span className="sh-btn-label">{completionsOn ? "Disable" : "Enable"}</span>
							</button>
						</div>
						<p className="hb-card-note">{PERMISSION_NOTES[permission]}</p>
					</section>

					<section className="hb-modal-section">
						<h3 className="hb-card-title">Display name</h3>
						<div className="hb-modal-row">
							<input
								className="sh-input"
								value={name}
								onChange={e => setName(e.target.value)}
								placeholder={DEFAULT_DISPLAY_NAME}
								maxLength={64}
								spellCheck={false}
								autoComplete="off"
							/>
							<button
								type="button"
								className="sh-btn"
								onClick={() => {
									setDisplayName(name);
									setSavedName(name.trim() || DEFAULT_DISPLAY_NAME);
								}}
							>
								Save
							</button>
						</div>
						<p className="hb-card-note">
							{savedName
								? `saved as “${savedName}” — applies to your next connection`
								: "applies to your next connection; this session keeps its current name"}
						</p>
					</section>
				</>
			)}
		</Modal>
	);
}
