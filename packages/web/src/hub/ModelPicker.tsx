/**
 * `/model` — model picker. Loads `AgentState` (current model + auth-available
 * models), groups the list by provider, filters as you type, and switches
 * through `POST /api/sessions/:id/model`. `ModelPickerView` is also embedded by
 * the settings modal (as a view swap), driven by the same loader.
 */
import { Check, LoaderCircle, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { Notice } from "../lib/client";
import type { AgentModel, AgentState } from "./api";
import { errorText, setModel } from "./api";
import { Modal } from "./Modal";
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

	const groups = useMemo(() => groupModels(load.state, filter), [load.state, filter]);
	const current = load.state?.model ?? null;

	const pick = (model: AgentModel): void => {
		setPending(`${model.provider}/${model.id}`);
		setError(null);
		void setModel(sessionId, model.provider, model.id).then(
			() => {
				notify("info", `model → ${model.name}`);
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
								<li key={id}>
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
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</>
	);
}
