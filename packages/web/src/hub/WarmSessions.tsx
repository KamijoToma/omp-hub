import type { ReactNode } from "react";
import { useEffect } from "react";
import { getDisplayName } from "./api";
import { clientPool } from "./client-pool";
import { useHiddenSessions } from "./hidden-sessions";
import { useSessionRecord, useSessions } from "./sessions-store";

/** Keep a bounded set of live rooms joined while the authenticated hub is open. */
export function WarmSessions({ currentId }: { currentId: string | null }): ReactNode {
	const { sessions } = useSessions();
	const { record } = useSessionRecord(currentId ?? "");
	const hidden = useHiddenSessions();

	useEffect(() => {
		if (sessions !== null) clientPool.sync(sessions, currentId, getDisplayName(), hidden, record);
	}, [sessions, currentId, hidden, record]);
	useEffect(() => () => clientPool.closeAll(), []);
	return null;
}
