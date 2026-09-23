/**
 * `/thinking` — thinking-level picker. Levels come from `AgentState`
 * (`thinkingLevels`, valid for the current model) and the switch goes through
 * `POST /api/sessions/:id/thinking`. `ThinkingPickerView` is also embedded by
 * the settings modal.
 */
import { Check, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Notice } from "../lib/client";
import { errorText, setThinking } from "./api";
import { Modal } from "./Modal";
import type { AgentStateLoad } from "./use-agent-state";
import { useAgentState } from "./use-agent-state";

export interface ThinkingPickerProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

export function ThinkingPicker({ sessionId, notify, onClose }: ThinkingPickerProps): ReactNode {
	const load = useAgentState(sessionId);
	return (
		<Modal title="Thinking" onClose={onClose}>
			<ThinkingPickerView load={load} sessionId={sessionId} notify={notify} onClose={onClose} />
		</Modal>
	);
}

export interface ThinkingPickerViewProps {
	load: AgentStateLoad;
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	/** Runs after a successful switch (the dialog closes). */
	onClose(): void;
}

export function ThinkingPickerView({ load, sessionId, notify, onClose }: ThinkingPickerViewProps): ReactNode {
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const current = load.state?.thinkingLevel ?? null;
	const levels = load.state?.thinkingLevels ?? [];

	const pick = (level: string): void => {
		setPending(level);
		setError(null);
		void setThinking(sessionId, level).then(
			result => {
				notify("info", `thinking → ${result.thinkingLevel}`);
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
				<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading thinking levels…
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
			{error && (
				<div className="hb-modal-error" role="alert">
					{error}
				</div>
			)}
			{levels.length === 0 ? (
				<p className="hb-empty">this model has no thinking levels</p>
			) : (
				<ul className="hb-pick-list">
					{levels.map(level => (
						<li key={level}>
							<button
								type="button"
								className={`hb-pick-row${level === current ? " hb-pick-row-current" : ""}`}
								onClick={() => pick(level)}
								disabled={pending !== null}
							>
								<span className="hb-pick-name">{level}</span>
								{level === current && <Check size={13} className="hb-pick-mark" aria-label="current" />}
								{pending === level && <LoaderCircle size={13} className="hb-spin" aria-label="setting" />}
							</button>
						</li>
					))}
				</ul>
			)}
			{current === null && <p className="hb-empty">the agent reported no effective level</p>}
		</>
	);
}
