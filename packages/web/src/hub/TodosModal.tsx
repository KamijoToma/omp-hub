/**
 * `/todo` — read-only view of the session's latest todo phases. The snapshot
 * comes from `GET /api/sessions/:id/todos` on open (and on refresh) — the
 * agent rewrites it as it works, so nothing is cached between opens.
 */
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { TodoPhase } from "./api";
import { errorText, getTodos } from "./api";
import { Modal } from "./Modal";

export interface TodosModalProps {
	/** Hub-assigned session id (`/s/<id>`), key for the todos API. */
	sessionId: string;
	onClose(): void;
}

export function TodosModal({ sessionId, onClose }: TodosModalProps): ReactNode {
	const [phases, setPhases] = useState<TodoPhase[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void getTodos(sessionId).then(
			next => {
				if (cancelled) return;
				setPhases(next);
				setError(null);
				setLoading(false);
			},
			(err: unknown) => {
				if (cancelled) return;
				setError(errorText(err));
				setLoading(false);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId, attempt]);

	const retry = useCallback(() => setAttempt(n => n + 1), []);

	return (
		<Modal title="Todos" onClose={onClose}>
			{loading ? (
				<p className="hb-busy">
					<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading todos…
				</p>
			) : error !== null ? (
				<>
					<div className="hb-modal-error" role="alert">
						{error}
					</div>
					<button type="button" className="sh-btn hb-ctx-retry" onClick={retry}>
						Retry
					</button>
				</>
			) : phases === null || phases.length === 0 ? (
				<p className="hb-empty">no todo list in this session — the agent creates one with its todo tool</p>
			) : (
				<>
					<TodoPhases phases={phases} />
					<button type="button" className="sh-btn hb-todo-refresh" onClick={retry}>
						<RefreshCw size={12} aria-hidden="true" />
						<span className="sh-btn-label">Refresh</span>
					</button>
				</>
			)}
		</Modal>
	);
}

function TodoPhases({ phases }: { phases: readonly TodoPhase[] }): ReactNode {
	return (
		<ul className="hb-todo-phases">
			{phases.map((phase, index) => (
				// Todo phases carry no id; name + position stay stable within a snapshot.
				<li className="hb-todo-phase" key={`${index}:${phase.name}`}>
					<div className="hb-todo-phase-name">{phase.name}</div>
					<ul className="hb-todo-tasks">
						{phase.tasks.map((task, taskIndex) => (
							<li className="hb-todo-task" key={`${taskIndex}:${task.content}`}>
								<span className={`hb-todo-chip hb-todo-${task.status}`}>{task.status}</span>
								<span className="hb-todo-content">{task.content}</span>
								{task.blocker && <span className="hb-todo-blocker">waiting for: {task.blocker}</span>}
							</li>
						))}
					</ul>
				</li>
			))}
		</ul>
	);
}
