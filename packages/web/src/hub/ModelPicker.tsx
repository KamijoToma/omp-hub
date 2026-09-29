/**
 * `/model` — model picker. Loads `AgentState` (current model + auth-available
 * models), groups the list by provider, filters as you type, and switches
 * through `POST /api/sessions/:id/model`. Role tabs switch the target role;
 * the active role's resolved assignment renders under the tabs with a
 * `clear → auto` unassign (0.10.0+ agents). `ModelPickerView` is also embedded
 * by the settings modal (as a view swap), driven by the same loader.
 *
 * Above the model list, remembered presets (`model-presets.ts`, per-browser)
 * render as quick-switch chips: one click re-applies a previously chosen
 * model + thinking level, and every successful switch records a preset.
 */
import { Check, History, LoaderCircle, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { Notice } from "../lib/client";
import type { AgentModel, AgentState } from "./api";
import { clearModelRole, errorText, setModel } from "./api";
import { Modal } from "./Modal";
import { joinPresets, rememberModelPreset, useModelPresets } from "./model-presets";
import type { AgentStateLoad } from "./use-agent-state";
import { useAgentState } from "./use-agent-state";

export interface ModelPickerProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

export function ModelPicker({ sessionId, notify, onClose }: ModelPickerProps): ReactNode {
	const load = useAgentState(sessionId);
	return (
		<Modal title="Model" onClose={onClose}>
			<ModelPickerView load={load} sessionId={sessionId} notify={notify} onClose={onClose} />
		</Modal>
	);
}

export interface ModelPickerViewProps {
	load: AgentStateLoad;
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	/** Runs after a successful switch (the dialog closes). */
	onClose(): void;
}

interface ModelGroup {
	provider: string;
	models: AgentModel[];
}

function groupModels(state: AgentState | null, filter: string): ModelGroup[] {
	if (!state) return [];
	const needle = filter.trim().toLowerCase();
	const groups = new Map<string, AgentModel[]>();
	for (const model of state.models) {
		const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
		if (needle && !haystack.includes(needle)) continue;
		const bucket = groups.get(model.provider);
		if (bucket) bucket.push(model);
		else groups.set(model.provider, [model]);
	}
	return [...groups].map(([provider, models]) => ({ provider, models }));
}

export function ModelPickerView({ load, sessionId, notify, onClose }: ModelPickerViewProps): ReactNode {
	const [filter, setFilter] = useState("");
	// `provider/id` of the model being switched to; all rows stay disabled while set.
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Active model-role tab (`"default"` = the plain session switch).
	const [roleTab, setRoleTab] = useState("default");
	// Per-row thinking preset, applied with the switch (`""` = the model's own default).
	const [levels, setLevels] = useState<Record<string, string>>({});

	const groups = useMemo(() => groupModels(load.state, filter), [load.state, filter]);
	// Remembered presets resolved against this agent's model list, MRU first.
	const storedPresets = useModelPresets();
	const presetRows = useMemo(
		() => (load.state ? joinPresets(storedPresets, load.state.models) : []),
		[storedPresets, load.state],
	);
	const roles = load.state?.roles ?? [];
	// Falls back when the host hides `"default"` via role tags.
	const activeRole = roles.some(entry => entry.role === roleTab) ? roleTab : (roles[0]?.role ?? "default");
	const activeEntry = roles.find(entry => entry.role === activeRole) ?? null;
	const current = activeEntry?.model ?? null;
	const currentKey = current ? `${current.provider}/${current.id}` : null;
	// Effective thinking level; a preset's `""` level matches the model's default.
	const activeLevel = load.state?.thinkingLevel ?? null;

	const pick = (model: AgentModel, levelOverride?: string): void => {
		setPending(`${model.provider}/${model.id}`);
		setError(null);
		const level = levelOverride ?? levels[`${model.provider}/${model.id}`];
		void setModel(sessionId, model.provider, model.id, {
			...(activeRole === "default" ? {} : { role: activeRole }),
			...(level ? { level } : {}),
		}).then(
			result => {
				// Successful switch ⇒ remembered for the quick-switch row (MRU bump).
				rememberModelPreset(model.provider, model.id, level ?? "");
				const role = activeRole === "default" ? "" : ` (${activeRole})`;
				notify(
					"info",
					level
						? `model → ${model.name}${role} · thinking → ${result.thinkingLevel ?? level}`
						: `model → ${model.name}${role}`,
				);
				onClose();
			},
			(err: unknown) => {
				setPending(null);
				setError(errorText(err));
			},
		);
	};

	// Unassign the active role (0.10.0+ agents): the persisted value drops and
	// auto-selection applies. `switched` means a cleared `default` moved the
	// active model onto the newly exposed assignment.
	const clearRole = (): void => {
		setPending("clear");
		setError(null);
		void clearModelRole(sessionId, activeRole).then(
			result => {
				notify(
					"info",
					result.switched
						? `role ${activeRole} cleared — active model follows the exposed assignment`
						: `role ${activeRole} cleared — auto-selection applies`,
				);
				onClose();
			},
			(err: unknown) => {
				setPending(null);
				setError(errorText(err));
			},
		);
	};

	if (!load.state && load.loading) {
		return (
			<p className="hb-busy">
				<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading models…
			</p>
		);
	}
	if (!load.state) {
		return (
			<div className="hb-modal-error" role="alert">
				{load.error ?? "agent state unavailable"}
			</div>
		);
	}

	return (
		<>
			{roles.length > 1 && (
				<>
					<div className="hb-role-tabs" role="tablist" aria-label="model roles">
						{roles.map(role => (
							<button
								key={role.role}
								type="button"
								role="tab"
								aria-selected={role.role === activeRole}
								className={`hb-role-tab${role.role === activeRole ? " hb-role-tab-current" : ""}`}
								onClick={() => setRoleTab(role.role)}
							>
								{role.name}
							</button>
						))}
					</div>
					{activeEntry && (
						<div className="hb-role-current">
							<span className="hb-role-current-label">{activeEntry.name}</span>
							<span className="hb-role-current-model">
								{activeEntry.model
									? `${activeEntry.model.provider}/${activeEntry.model.id}`
									: "unassigned"}
								{activeEntry.auto && <span className="hb-role-auto">auto</span>}
							</span>
							{activeEntry.model && !activeEntry.auto && (
								<button
									type="button"
									className="hb-role-clear"
									disabled={pending !== null}
									onClick={clearRole}
								>
									clear → auto
								</button>
							)}
						</div>
					)}
				</>
			)}
			{presetRows.length > 0 && (
				<div className="hb-preset-bar" role="toolbar" aria-label="recent models">
					<History size={13} className="hb-preset-icon" aria-hidden="true" />
					{presetRows.map(({ preset, key, model }) => {
						const isCurrent =
							key === currentKey &&
							(preset.level
								? preset.level === activeLevel
								: activeLevel == null || activeLevel === (model.defaultThinkingLevel ?? ""));
						return (
							<button
								key={key}
								type="button"
								className={`hb-preset-chip${isCurrent ? " hb-preset-chip-current" : ""}`}
								title={`${preset.provider}/${preset.modelId}${preset.level ? ` · ${preset.level}` : ""}`}
								onClick={() => pick(model, preset.level || undefined)}
								disabled={pending !== null}
							>
								{isCurrent && <Check size={11} className="hb-preset-mark" aria-label="current" />}
								<span className="hb-preset-name">{model.name}</span>
								{preset.level && <span className="hb-preset-level">{preset.level}</span>}
							</button>
						);
					})}
				</div>
			)}
			<label className="hb-search">
				<Search size={13} className="hb-search-icon" aria-hidden="true" />
				<input
					className="sh-input hb-search-input"
					value={filter}
					onChange={e => setFilter(e.target.value)}
					placeholder="filter models…"
					spellCheck={false}
					autoComplete="off"
				/>
			</label>
			{error && (
				<div className="hb-modal-error" role="alert">
					{error}
				</div>
			)}
			{groups.length === 0 && <p className="hb-empty">no models match</p>}
			{groups.map(group => (
				<div className="hb-pick-group" key={group.provider}>
					<div className="hb-pick-group-label">{group.provider}</div>
					<ul className="hb-pick-list">
						{group.models.map(model => {
							const id = `${model.provider}/${model.id}`;
							const isCurrent = current?.provider === model.provider && current.id === model.id;
							return (
								<li key={id} className="hb-pick-item">
									<button
										type="button"
										className={`hb-pick-row${isCurrent ? " hb-pick-row-current" : ""}`}
										onClick={() => pick(model)}
										disabled={pending !== null}
									>
										<span className="hb-pick-name">{model.name}</span>
										{isCurrent && <Check size={13} className="hb-pick-mark" aria-label="current" />}
										{pending === id ? (
											<LoaderCircle size={13} className="hb-spin" aria-label="switching" />
										) : (
											<span className="hb-pick-id">{model.id}</span>
										)}
									</button>
									{model.thinkingEfforts.length > 0 && (
										<select
											className="sh-input hb-pick-thinking"
											value={levels[id] ?? ""}
											disabled={pending !== null}
											aria-label={`thinking level for ${model.name}`}
											onChange={e => setLevels(prev => ({ ...prev, [id]: e.target.value }))}
										>
											<option value="">
												{model.defaultThinkingLevel ? `default (${model.defaultThinkingLevel})` : "default"}
											</option>
											<option value="off">off</option>
											{model.thinkingEfforts.map(effort => (
												<option key={effort} value={effort}>
													{effort}
												</option>
											))}
										</select>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</>
	);
}
