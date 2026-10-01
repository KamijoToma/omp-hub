/**
 * `/model` — one-query model palette. Loads `AgentState` (current model +
 * auth-available models + roles) and drives everything from a single search
 * field with the omp TUI picker's grammar: raw text fuzzy-filters models,
 * a leading `@` flips the list to role rows, a trailing `:level` arms a
 * thinking override for the next activation. Rows are keyboard-navigable
 * (arrows/Enter) with a pinned detail strip bound to the highlighted row; the
 * strip carries the per-model thinking chips (replacing the old per-row
 * selects) and, for role rows, `use now` (TUI quick-apply parity) and
 * `clear → auto` (0.10.0+ unassign). Switches go through
 * `POST /api/sessions/:id/model`; every successful switch records a preset
 * (`model-presets.ts`, per-browser MRU) which renders as the Recent section.
 *
 * `ModelPickerView` is also embedded by the settings modal (as a view swap),
 * driven by the same loader; its props are the view's only contract.
 */
import { Check, CornerDownLeft, History, LoaderCircle, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Notice } from "../lib/client";
import type { AgentModel, AgentRole, AgentState } from "./api";
import { clearModelRole, errorText, setModel } from "./api";
import { Modal } from "./Modal";
import { joinPresets, rememberModelPreset, useModelPresets, type ModelPreset } from "./model-presets";
import { filterRoles, knownLevels, parseQuery, rankModels, rolesByModel } from "./model-search";
import type { AgentStateLoad } from "./use-agent-state";
import { useAgentState } from "./use-agent-state";

export interface ModelPickerProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
	/** Dialog title; `/thinking` opens this palette as `"Thinking"`. */
	title?: string;
	/** Seed query (the `/model <pattern>` args), parsed by the same grammar. */
	initialQuery?: string;
}

export function ModelPicker({ sessionId, notify, onClose, title = "Model", initialQuery = "" }: ModelPickerProps): ReactNode {
	const load = useAgentState(sessionId);
	return (
		// Esc is fully delegated to the view's ladder (clear query → exit
		// role drill-in → close), so the modal must not close on its own.
		<Modal title={title} onClose={onClose} onEscape={() => true}>
			<ModelPickerView load={load} sessionId={sessionId} notify={notify} onClose={onClose} initialQuery={initialQuery} />
		</Modal>
	);
}

export interface ModelPickerViewProps {
	load: AgentStateLoad;
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	/** Runs after a successful switch (the dialog closes). */
	onClose(): void;
	/** Seed query, e.g. from `/model sonnet:high`. */
	initialQuery?: string;
}

interface PresetRow {
	kind: "preset";
	key: string;
	model: AgentModel;
	preset: ModelPreset;
}

interface RoleRow {
	kind: "role";
	key: string;
	role: AgentRole;
}

interface ModelRow {
	kind: "model";
	key: string;
	model: AgentModel;
}

type PickerRow = PresetRow | RoleRow | ModelRow;

/** Group label injected between row runs; skipped by keyboard navigation. */
interface LabelRow {
	kind: "label";
	key: string;
	text: string;
}

type RenderRow = PickerRow | LabelRow;

const optId = (index: number): string => `hb-pick-opt-${index}`;

export function ModelPickerView({ load, sessionId, notify, onClose, initialQuery = "" }: ModelPickerViewProps): ReactNode {
	const [query, setQuery] = useState(initialQuery);
	// `provider/id` of the model being switched to, or `"clear"`; all commits stay disabled while set.
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Role the next model pick assigns to (drill-in from a role row); `null` = session switch.
	const [roleTarget, setRoleTarget] = useState<string | null>(null);
	const [highlight, setHighlight] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const didInit = useRef(false);

	const state = load.state;
	const levels = useMemo(() => (state ? knownLevels(state.models) : []), [state]);
	const parsed = useMemo(() => parseQuery(query, levels, state?.models ?? []), [query, levels, state]);
	const storedPresets = useModelPresets();
	const presetRows = useMemo(
		() => (state ? joinPresets(storedPresets, state.models) : []),
		[storedPresets, state],
	);
	const presetIndex = useMemo(
		() => new Map(presetRows.map((row, index) => [row.key, index] as const)),
		[presetRows],
	);
	const currentKey = state?.model ? `${state.model.provider}/${state.model.id}` : null;
	const serving = useMemo(() => (state ? rolesByModel(state.roles) : new Map<string, string[]>()), [state]);

	// Flat, keyboard-navigable row run. Labels are render-only.
	const rows = useMemo<RenderRow[]>(() => {
		if (!state) return [];
		const run: RenderRow[] = [];
		if (roleTarget !== null) {
			// Drill-in: assign a model to the role; presets/roles are noise here.
			const ranked = rankModels(state.models, parsed, {
				roles: state.roles,
				presetIndex: presetIndex,
				currentKey: null,
			});
			if (parsed.needle === "") run.push({ kind: "label", key: "label-target", text: `assign to ${roleTarget}` });
			for (const row of ranked) run.push({ kind: "model", key: `model:${row.key}`, model: row.model });
			return run;
		}
		if (parsed.roleMode) {
			const matching = filterRoles(state.roles, parsed.needle);
			if (parsed.needle === "") run.push({ kind: "label", key: "label-roles", text: "roles" });
			for (const role of matching) run.push({ kind: "role", key: `role:${role.role}`, role });
			return run;
		}
		if (parsed.needle === "" && parsed.level === undefined) {
			if (presetRows.length > 0) {
				run.push({ kind: "label", key: "label-recent", text: "recent" });
				for (const entry of presetRows) {
					run.push({ kind: "preset", key: `preset:${entry.key}`, model: entry.model, preset: entry.preset });
				}
			}
			if (state.roles.length > 0) {
				run.push({ kind: "label", key: "label-roles", text: "roles" });
				for (const role of state.roles) run.push({ kind: "role", key: `role:${role.role}`, role });
			}
			run.push({ kind: "label", key: "label-models", text: "models" });
		}
		const ranked = rankModels(state.models, parsed, {
			roles: state.roles,
			presetIndex: presetIndex,
			currentKey: currentKey,
		});
		for (const row of ranked) run.push({ kind: "model", key: `model:${row.key}`, model: row.model });
		return run;
	}, [state, roleTarget, parsed, presetRows, presetIndex, currentKey]);

	const selectable = useMemo(
		() => rows.map((row, index) => (row.kind === "label" ? null : index)).filter((index): index is number => index !== null),
		[rows],
	);
	const active = state && rows[highlight]?.kind !== "label" && rows[highlight] !== undefined ? (rows[highlight] as PickerRow) : null;

	// On first load, highlight the session's current model; clamp afterwards.
	useEffect(() => {
		if (!state || didInit.current) return;
		didInit.current = true;
		const index = selectable.find(i => {
			const row = rows[i] as PickerRow;
			return (row.kind === "model" || row.kind === "preset") && `${row.model.provider}/${row.model.id}` === currentKey;
		});
		setHighlight(index ?? selectable[0] ?? 0);
	}, [state, rows, selectable, currentKey]);
	useEffect(() => {
		setHighlight(highlight => Math.min(highlight, Math.max(0, selectable.length - 1)));
	}, [selectable.length]);
	// Keyboard navigation scrolls the highlighted option into view.
	useEffect(() => {
		document.getElementById(optId(highlight))?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const move = (delta: 1 | -1 | "home" | "end"): void => {
		if (selectable.length === 0) return;
		setHighlight(current => {
			const at = selectable.indexOf(current >= 0 && rows[current]?.kind !== "label" ? current : selectable[0]!);
			if (delta === "home") return selectable[0]!;
			if (delta === "end") return selectable[selectable.length - 1]!;
			const next = (at + delta + selectable.length) % selectable.length;
			return selectable[next]!;
		});
	};

	const pick = (model: AgentModel, levelOverride?: string): void => {
		setPending(`${model.provider}/${model.id}`);
		setError(null);
		const role = roleTarget !== null && roleTarget !== "default" ? roleTarget : undefined;
		const level = levelOverride ?? parsed.level;
		void setModel(sessionId, model.provider, model.id, {
			...(role === undefined ? {} : { role }),
			...(level ? { level } : {}),
		}).then(
			result => {
				// Successful switch ⇒ remembered for the Recent section (MRU bump).
				rememberModelPreset(model.provider, model.id, level ?? "");
				const roleSuffix = role ? ` (${role})` : "";
				notify(
					"info",
					level
						? `model → ${model.name}${roleSuffix} · thinking → ${result.thinkingLevel ?? level}`
						: `model → ${model.name}${roleSuffix}`,
				);
				onClose();
			},
			(err: unknown) => {
				setPending(null);
				setError(errorText(err));
			},
		);
	};

	// TUI quick-apply: put the role's resolved model on the session without
	// touching the persisted role assignment.
	const useRoleModel = (role: AgentRole): void => {
		if (!role.model) return;
		pick(role.model, undefined);
	};

	// Unassign the role (0.10.0+ agents): the persisted value drops and
	// auto-selection applies. `switched` means a cleared `default` moved the
	// active model onto the newly exposed assignment.
	const clearRole = (role: string): void => {
		setPending("clear");
		setError(null);
		void clearModelRole(sessionId, role).then(
			result => {
				notify(
					"info",
					result.switched
						? `role ${role} cleared — active model follows the exposed assignment`
						: `role ${role} cleared — auto-selection applies`,
				);
				onClose();
			},
			(err: unknown) => {
				setPending(null);
				setError(errorText(err));
			},
		);
	};

	const activate = (row: PickerRow): void => {
		if (row.kind === "role") {
			setRoleTarget(row.role.role);
			setQuery("");
			setHighlight(0);
			inputRef.current?.focus();
			return;
		}
		if (row.kind === "preset") {
			pick(row.model, row.preset.level || undefined);
			return;
		}
		pick(row.model);
	};

	// Esc ladder + drill-in exit, shared by the input and the view root
	// (Modal's document-capture Esc is a no-op while this palette is open).
	const escape = (): void => {
		if (query !== "") {
			setQuery("");
			return;
		}
		if (roleTarget !== null) {
			setRoleTarget(null);
			setHighlight(0);
			inputRef.current?.focus();
			return;
		}
		onClose();
	};

	const onKeyDown = (e: React.KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			escape();
			return;
		}
		// Arrows/Enter only act from the search field; `currentTarget` is always
		// this root div (React synthetic), so compare against the event source.
		if (e.target !== inputRef.current) return; // arrows/enter only from the field
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				move(1);
				break;
			case "ArrowUp":
				e.preventDefault();
				move(-1);
				break;
			case "Home":
				e.preventDefault();
				move("home");
				break;
			case "End":
				e.preventDefault();
				move("end");
				break;
			case "Enter":
				e.preventDefault();
				if (pending === null && active) activate(active);
				break;
			case "Backspace":
				if (query === "" && roleTarget !== null) {
					e.preventDefault();
					setRoleTarget(null);
					setHighlight(0);
				}
				break;
		}
	};

	if (!state && load.loading) {
		return (
			<p className="hb-busy">
				<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading models…
			</p>
		);
	}
	if (!state) {
		return (
			<div className="hb-modal-error" role="alert">
				{load.error ?? "agent state unavailable"}
			</div>
		);
	}

	const hint = roleTarget !== null
		? `assigning ${roleTarget} — pick a model · backspace exits`
		: parsed.roleMode
			? "enter applies a role's model to the session · drill in to reassign"
			: "switches this session only — role assignments unchanged";

	return (
		<div className="hb-palette-body" onKeyDown={onKeyDown}>
			<label className="hb-search">
				<Search size={13} className="hb-search-icon" aria-hidden="true" />
				<input
					ref={inputRef}
					className="sh-input hb-search-input"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder="filter models · @ roles · : thinking"
					spellCheck={false}
					autoComplete="off"
					autoFocus
					role="combobox"
					aria-expanded="true"
					aria-controls="hb-pick-list"
					aria-activedescendant={active ? optId(highlight) : undefined}
					aria-label="filter models, @ for roles, :level for thinking"
				/>
				{parsed.level && (
					<span className="hb-query-level" title="thinking level applied to the next pick">
						<CornerDownLeft size={10} aria-hidden="true" /> {parsed.level}
					</span>
				)}
			</label>
			<p className="hb-pick-hint">{hint}</p>
			{error && (
				<div className="hb-modal-error" role="alert">
					{error}
				</div>
			)}
			<div className="hb-pick-listbox" id="hb-pick-list" role="listbox" aria-label="models and roles">
				{selectable.length === 0 && (
					<p className="hb-empty">{parsed.roleMode ? "no roles match" : "no models match"}</p>
				)}
				{rows.map((row, index) => {
					if (row.kind === "label") {
						return (
							<div key={row.key} role="presentation" className="hb-pick-group-label">
								{row.text}
							</div>
						);
					}
					const isActive = index === highlight;
					if (row.kind === "role") {
						const role = row.role;
						const assignment = role.model ? `${role.model.provider}/${role.model.id}` : "unassigned";
						return (
							<button
								key={row.key}
								type="button"
								role="option"
								id={optId(index)}
								aria-selected={isActive}
								className={`hb-pick-row hb-role-row${isActive ? " hb-pick-row-active" : ""}`}
								onMouseDown={e => e.preventDefault()}
								onClick={() => activate(row)}
								disabled={pending !== null}
							>
								<span className="hb-pick-name">@{role.role}</span>
								<span className="hb-pick-sub">{role.name}</span>
								<span className="hb-pick-id">{assignment}</span>
								{role.auto && role.model && <span className="hb-role-auto">auto</span>}
							</button>
						);
					}
					const model = row.model;
					const key = `${model.provider}/${model.id}`;
					const isCurrent = key === currentKey && row.kind === "model";
					return (
						<button
							key={row.key}
							type="button"
							role="option"
							id={optId(index)}
							aria-selected={isActive}
							className={`hb-pick-row${isActive ? " hb-pick-row-active" : ""}${isCurrent ? " hb-pick-row-current" : ""}`}
							onMouseDown={e => e.preventDefault()}
							onClick={() => activate(row)}
							disabled={pending !== null}
						>
							{row.kind === "preset" && <History size={12} className="hb-preset-icon" aria-hidden="true" />}
							<span className="hb-pick-name">{model.name}</span>
							{row.kind === "preset" && row.preset.level && (
								<span className="hb-preset-level">{row.preset.level}</span>
							)}
							{isCurrent && <Check size={13} className="hb-pick-mark" aria-label="current" />}
							{pending === key ? (
								<LoaderCircle size={13} className="hb-spin" aria-label="switching" />
							) : (
								<span className="hb-pick-id">{key}</span>
							)}
						</button>
					);
				})}
			</div>
			<DetailStrip
				row={active}
				state={state}
				serving={serving}
				currentKey={currentKey}
				pending={pending}
				onPick={pick}
				onUseRole={useRoleModel}
				onClearRole={clearRole}
			/>
			<p className="hb-pick-keys" aria-hidden="true">
				↑↓ navigate · enter select · @ roles · :level thinking · esc close
			</p>
		</div>
	);
}

/**
 * Pinned detail strip bound to the highlighted row: model facts plus the
 * thinking-level commit chips (a chip on the session's current model only
 * changes the level), or a role row's assignment with its `use` / `clear →
 * auto` actions. Errors also land here so they stay visible above the fold.
 */
function DetailStrip(props: {
	row: PickerRow | null;
	state: AgentState;
	serving: Map<string, string[]>;
	currentKey: string | null;
	pending: string | null;
	onPick(model: AgentModel, level?: string): void;
	onUseRole(role: AgentRole): void;
	onClearRole(role: string): void;
}): ReactNode {
	const { row, state, serving, currentKey, pending, onPick, onUseRole, onClearRole } = props;
	if (!row) return null;

	if (row.kind === "role") {
		const role = row.role;
		return (
			<div className="hb-pick-detail">
				<span className="hb-pick-facts">
					<span className="hb-pick-facts-name">{role.name}</span>
					{role.model ? (
						<span className="hb-pick-id">
							{role.model.provider}/{role.model.id}
						</span>
					) : (
						<span className="hb-pick-sub">unassigned</span>
					)}
					{role.auto && role.model && <span className="hb-role-auto">auto</span>}
				</span>
				<span className="hb-pick-actions">
					{role.model && (
						<button type="button" className="sh-btn" disabled={pending !== null} onClick={() => onUseRole(role)}>
							use now
						</button>
					)}
					{role.model && !role.auto && (
						<button type="button" className="hb-role-clear" disabled={pending !== null} onClick={() => onClearRole(role.role)}>
							clear → auto
						</button>
					)}
				</span>
			</div>
		);
	}

	const model = row.model;
	const key = `${model.provider}/${model.id}`;
	const isCurrent = key === currentKey;
	const chips = ["default", ...(model.thinkingEfforts.includes("off") ? [] : ["off"]), ...model.thinkingEfforts];
	const chipOn = (chip: string): boolean =>
		isCurrent &&
		(chip === "default"
			? state.thinkingLevel !== null && state.thinkingLevel === (model.defaultThinkingLevel ?? "")
			: state.thinkingLevel === chip);
	const servers = serving.get(key);
	return (
		<div className="hb-pick-detail">
			<span className="hb-pick-facts">
				<span className="hb-pick-facts-name">{model.name}</span>
				<span className="hb-pick-id">
					{model.provider}/{model.id}
				</span>
				{isCurrent && <span className="hb-tree-chip">current</span>}
				{servers && <span className="hb-pick-sub">serves: {servers.join(", ")}</span>}
			</span>
			<span className="hb-pick-actions" aria-label="thinking level">
				{chips.map(chip => (
					<button
						key={chip}
						type="button"
						className={`hb-level-chip${chipOn(chip) ? " hb-level-chip-on" : ""}`}
						disabled={pending !== null}
						title={chip === "default" ? "use the model's default effort" : `switch with thinking ${chip}`}
						onClick={() => onPick(model, chip === "default" ? undefined : chip)}
					>
						{chip === "default" && model.defaultThinkingLevel ? `default (${model.defaultThinkingLevel})` : chip}
					</button>
				))}
			</span>
		</div>
	);
}
