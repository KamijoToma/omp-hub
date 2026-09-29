/**
 * "Advanced" view of `/settings` (docs/protocol.md §6): the hub-curated
 * allowlist of the agent's typed settings (agent `get-settings`, 0.9.0+),
 * grouped by the descriptor's tab/group hints. Rows edit in place — booleans
 * and enums apply immediately, numbers/strings apply on Enter or blur — and
 * every apply POSTs a session-scoped runtime override (agent `set-setting`)
 * that never persists to `settings.json`. Overridden rows carry a marker and
 * a reset affordance (`value: null` clears the override).
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { Notice } from "../lib/client";
import type { SettingWire } from "./api";
import { errorText, getSessionSettings, postSessionSetting } from "./api";

export interface AdvancedSettingsProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
}

/** Rows keyed by their tab + group hints, in first-appearance order. */
interface SettingGroup {
	key: string;
	label: string;
	settings: SettingWire[];
}

function groupSettings(settings: readonly SettingWire[]): SettingGroup[] {
	const groups = new Map<string, SettingGroup>();
	for (const setting of settings) {
		const label = setting.group ?? setting.tab ?? "Other";
		let group = groups.get(label);
		if (!group) {
			group = { key: label, label, settings: [] };
			groups.set(label, group);
		}
		group.settings.push(setting);
	}
	return [...groups.values()];
}

/** Truthy display of the current value for non-editable/complex types. */
function previewValue(value: unknown): string {
	if (value === null || value === undefined) return "not set";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/** One setting row: local draft for text/number inputs, immediate apply otherwise. */
function SettingRow({
	sessionId,
	setting,
	notify,
	onApplied,
}: {
	sessionId: string;
	setting: SettingWire;
	notify(level: Notice["level"], message: string): void;
	onApplied(next: SettingWire): void;
}): ReactNode {
	const [draft, setDraft] = useState(() => previewValue(setting.value));
	// Re-sync the draft when an apply (here or elsewhere) replaces the row.
	const [source, setSource] = useState(setting);
	if (source !== setting) {
		setSource(setting);
		setDraft(previewValue(setting.value));
	}

	const apply = (value: unknown, describe: string): void => {
		void postSessionSetting(sessionId, setting.id, value).then(
			next => {
				onApplied(next);
				notify("info", `${setting.id} — ${describe}`);
			},
			(err: unknown) => notify("error", errorText(err)),
		);
	};

	const applyDraft = (): void => {
		const text = draft.trim();
		if (text === previewValue(setting.value)) return;
		if (setting.type === "number") {
			const parsed = Number(text);
			if (text === "" || Number.isNaN(parsed)) {
				notify("warning", `${setting.id} — enter a number`);
				return;
			}
			apply(parsed, `set to ${parsed}`);
			return;
		}
		// string rows take the raw text; array/record rows parse as JSON.
		if (setting.type === "string") {
			apply(text, `set to “${text}”`);
			return;
		}
		try {
			apply(JSON.parse(text), "override applied");
		} catch {
			notify("warning", `${setting.id} — enter valid JSON`);
		}
	};

	const overridden = setting.overridden;

	return (
		<div className="hb-modal-row hb-setting-row">
			<div className="hb-setting-info">
				<span className="hb-modal-value hb-setting-id" title={setting.description}>
					{setting.id}
					{overridden && <span className="hb-setting-override">override</span>}
				</span>
				<span className="hb-setting-desc">{setting.description}</span>
			</div>
			<div className="hb-setting-control">
				{setting.type === "boolean" && typeof setting.value === "boolean" ? (
					<button
						type="button"
						className="sh-btn"
						onClick={() => apply(!setting.value, setting.value ? "off" : "on")}
						title={setting.description}
					>
						{setting.value ? "on" : "off"}
					</button>
				) : setting.type === "enum" && setting.values ? (
					<select
						className="sh-input"
						value={previewValue(setting.value)}
						onChange={e => apply(e.target.value, `set to ${e.target.value}`)}
					>
						{previewValue(setting.value) === "not set" && <option value="not set">not set</option>}
						{setting.values.map(v => (
							<option key={v} value={v}>
								{v}
							</option>
						))}
					</select>
				) : setting.type === "boolean" ? (
					<span className="hb-modal-value">{previewValue(setting.value)}</span>
				) : (
					<input
						className="sh-input"
						value={draft}
						spellCheck={false}
						autoComplete="off"
						aria-label={setting.id}
						onChange={e => setDraft(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") applyDraft();
						}}
						onBlur={applyDraft}
					/>
				)}
				{overridden && (
					<button
						type="button"
						className="sh-btn"
						title="clear the session override"
						onClick={() => apply(null, "override cleared")}
					>
						<RotateCcw size={12} aria-hidden="true" />
					</button>
				)}
			</div>
		</div>
	);
}

export function AdvancedSettings({ sessionId, notify }: AdvancedSettingsProps): ReactNode {
	const [settings, setSettings] = useState<SettingWire[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSettings(null);
		setError(null);
		void getSessionSettings(sessionId).then(
			next => {
				if (cancelled) return;
				setSettings(next);
			},
			(err: unknown) => {
				if (cancelled) return;
				setError(errorText(err));
			},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const groups = useMemo(() => (settings ? groupSettings(settings) : []), [settings]);
	const onApplied = (next: SettingWire): void => {
		setSettings(prev => (prev ? prev.map(s => (s.id === next.id ? next : s)) : prev));
	};

	if (error) {
		return (
			<div className="hb-modal-error" role="alert">
				{error}
			</div>
		);
	}
	if (!settings) {
		return (
			<div className="hb-modal-row">
				<span className="hb-modal-value">loading…</span>
			</div>
		);
	}

	return (
		<>
			<p className="hb-card-note">
				Session-scoped overrides — they die with this session and never persist to settings.json.
			</p>
			{groups.map(group => (
				<section key={group.key} className="hb-modal-section">
					<h3 className="hb-card-title">{group.label}</h3>
					{group.settings.map(setting => (
						<SettingRow key={setting.id} sessionId={sessionId} setting={setting} notify={notify} onApplied={onApplied} />
					))}
				</section>
			))}
		</>
	);
}
