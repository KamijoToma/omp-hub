/**
 * The omp collab host echoes every guest join into the room as a `notice`
 * (collab/host.ts `#handleHello`: "<name> joined the collab session[ (read-only)]").
 * In the hub, joining is what switching to a session is, so the echo fires on
 * every sidebar switch, reload, and reconnect and toasts top-right. The hub
 * surface suppresses that echo for the local guest; other peers' joins still
 * surface.
 */

/** True when the notice is this guest's own join echo (exact host wording). */
export function isSelfJoinNotice(message: string, displayName: string): boolean {
	// The host stamps the notice with `name.trim().slice(0, 64)` (collab/host.ts).
	const name = displayName.trim().slice(0, 64);
	if (name === "") return false;
	return (
		message === `${name} joined the collab session` ||
		message === `${name} joined the collab session (read-only)`
	);
}
