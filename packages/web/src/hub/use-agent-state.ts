/**
 * `AgentState` loader for the slash-command pickers (docs/protocol.md §3):
 * fetches `GET /api/sessions/:id/agent-state` on mount and surfaces the hub's
 * error text (404 unknown, 409 not live, 502 agent offline, 504 timeout) for
 * inline display. `refresh()` re-fetches after an action (goal/loop modals).
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentState } from "./api";
import { errorText, getAgentState } from "./api";

export interface AgentStateLoad {
	state: AgentState | null;
	error: string | null;
	loading: boolean;
	/** Re-runs the fetch; in-flight replies from an earlier run are dropped. */
	refresh(): void;
}

export function useAgentState(sessionId: string): AgentStateLoad {
	const [state, setState] = useState<AgentState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);
	const refresh = useCallback(() => setAttempt(n => n + 1), []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void getAgentState(sessionId).then(
			next => {
				if (cancelled) return;
				setState(next);
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

	return { state, error, loading, refresh };
}
