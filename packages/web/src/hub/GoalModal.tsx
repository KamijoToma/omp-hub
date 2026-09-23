/**
 * `/goal` — drive the session's goal runtime. The status card reads the
 * `goal` field of the shared `agent-state` fetch; every action POSTs
 * `…/goal` and refreshes the state, so the card and the buttons always
 * describe what the agent last confirmed. Button availability mirrors the
 * SDK's own guards (create needs no live goal, replace needs an enabled one,
 * resume needs a paused one); agent-side rejections surface as notices.
 */
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Notice } from "../lib/client";
import type { GoalAction, GoalModeState } from "./api";
import { errorText, postGoal } from "./api";
import { Modal } from "./Modal";
import type { AgentStateLoad } from "./use-agent-state";
import { useAgentState } from "./use-agent-state";

export interface GoalModalProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

export function GoalModal({ sessionId, notify, onClose }: GoalModalProps): ReactNode {
	const load = useAgentState(sessionId);
	return (
		<Modal title="Goal" onClose={onClose}>
			<GoalModalBody sessionId={sessionId} load={load} notify={notify} />
		</Modal>
	);
}

interface GoalModalBodyProps {
	sessionId: string;
	load: AgentStateLoad;
	notify(level: Notice["level"], message: string): void;
}

function GoalModalBody({ sessionId, load, notify }: GoalModalBodyProps): ReactNode {
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");
	const [pending, setPending] = useState<GoalAction | null>(null);

	const goal = load.state?.goal ?? null;
	const status = goal?.goal;

	// An empty budget field clears the goal's budget; a filled one must be a
	// positive integer of tokens — the agent rejects anything else.
	const budgetValue = budget.trim() === "" ? undefined : Number(budget.trim());
	const budgetValid = budgetValue === undefined || (Number.isSafeInteger(budgetValue) && budgetValue > 0);

	const canSet = goal === null || status?.status === "complete" || status?.status === "dropped";
	const canReplace = goal !== null && goal.enabled;
	const canPause = status !== undefined && (status.status === "active" || status.status === "budget-limited");
	const canResume = goal !== null && !goal.enabled && status?.status !== "complete";
	const canDrop = goal !== null;
	const canBudget = goal !== null && budgetValid;

	const act = (action: GoalAction): void => {
		const text = objective.trim();
		if ((action === "set" || action === "replace") && !text) {
			notify("warning", "an objective is required");
			return;
		}
		setPending(action);
		void postGoal(sessionId, {
			action,
			...(action === "set" || action === "replace" ? { objective: text } : {}),
			...(action === "budget" ? { tokenBudget: budgetValue } : {}),
		}).then(
			result => {
				setPending(null);
				setObjective("");
				setBudget("");
				load.refresh();
				const current = result?.goal;
				if (action === "drop" || !current) notify("info", "goal dropped");
				else notify("info", `goal ${current.status} — ${current.objective}`);
			},
			(err: unknown) => {
				setPending(null);
				notify("error", errorText(err));
			},
		);
	};

	if (!load.state && load.loading) {
		return (
			<p className="hb-busy">
				<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading goal…
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
			<section className="hb-modal-section">
				<h3 className="hb-card-title">Status</h3>
				{goal === null ? (
					<p className="hb-empty">no goal — set an objective below</p>
				) : (
					<GoalStatus goal={goal} />
				)}
			</section>

			<section className="hb-modal-section">
				<h3 className="hb-card-title">Objective</h3>
				<textarea
					className="sh-input hb-textarea"
					value={objective}
					onChange={e => setObjective(e.target.value)}
					placeholder="what the agent should keep working toward…"
					rows={3}
					disabled={pending !== null}
				/>
				<input
					className="sh-input"
					value={budget}
					onChange={e => setBudget(e.target.value)}
					placeholder="token budget (optional — empty clears it)"
					inputMode="numeric"
					spellCheck={false}
					autoComplete="off"
					disabled={pending !== null}
					aria-label="token budget"
				/>
			</section>

			<div className="hb-ops-actions">
				<button type="button" className="sh-btn" onClick={() => act("set")} disabled={!canSet || pending !== null}>
					Set
				</button>
				<button
					type="button"
					className="sh-btn"
					onClick={() => act("replace")}
					disabled={!canReplace || pending !== null}
				>
					Replace
				</button>
				<button type="button" className="sh-btn" onClick={() => act("pause")} disabled={!canPause || pending !== null}>
					Pause
				</button>
				<button
					type="button"
					className="sh-btn"
					onClick={() => act("resume")}
					disabled={!canResume || pending !== null}
				>
					Resume
				</button>
				<button type="button" className="sh-btn" onClick={() => act("drop")} disabled={!canDrop || pending !== null}>
					Drop
				</button>
				<button
					type="button"
					className="sh-btn"
					onClick={() => act("budget")}
					disabled={!canBudget || pending !== null}
				>
					Budget
				</button>
				{pending !== null && <LoaderCircle size={13} className="hb-spin" aria-label="working" />}
			</div>
			{load.error && (
				<div className="hb-modal-error" role="alert">
					{load.error}
				</div>
			)}
			<p className="hb-card-note">
				Set creates a goal, Replace rewrites the active one, Budget applies the token field to the current goal.
			</p>
		</>
	);
}

function GoalStatus({ goal }: { goal: GoalModeState }): ReactNode {
	const { goal: current, enabled, reason } = goal;
	return (
		<div className="hb-goal-status">
			<div className="hb-goal-objective">{current.objective}</div>
			<div className="hb-goal-meta">
				<span className={`hb-goal-badge hb-goal-${current.status}`}>{current.status}</span>
				<span className="hb-goal-tokens">
					{current.tokensUsed}
					{current.tokenBudget !== undefined ? ` / ${current.tokenBudget} tokens` : " tokens"}
				</span>
				{!enabled && <span className="hb-goal-meta-note">paused</span>}
				{reason === "completed" && <span className="hb-goal-meta-note">completed</span>}
			</div>
		</div>
	);
}
