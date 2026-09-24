/**
 * Joins the home History card's omp rows against the polled hub registry: the
 * supervisor reports each child's resolved session file on `session-ready`, so
 * `SessionRecord.sessionFile === entry.path` identifies the live hub session
 * backing a history row (the supervisor's double-open guard relies on the same
 * equality, so at most one session can hold a file).
 */
import type { MachineSession, SessionRecord } from "./api";

/** Agent state shown on one history card row. */
export type HistoryStatusKind = "working" | "input" | "idle";

export interface HistoryStatus {
	/** Hub session id backing the row. */
	sessionId: string;
	kind: HistoryStatusKind;
}

/**
 * State of the live hub session holding `entry`'s file, or null when none
 * exists on `machineId` (never started from the hub, or already exited).
 * `input` outranks `working`; absent activity (older agents) reads as idle.
 */
export function historyStatus(
	entry: Pick<MachineSession, "path">,
	machineId: string,
	sessions: readonly SessionRecord[],
): HistoryStatus | null {
	const live = sessions.find(
		session =>
			session.machineId === machineId && session.status === "live" && session.sessionFile === entry.path,
	);
	if (!live) return null;
	if (live.activity?.inputRequired === true) return { sessionId: live.id, kind: "input" };
	if (live.activity?.working === true) return { sessionId: live.id, kind: "working" };
	return { sessionId: live.id, kind: "idle" };
}
