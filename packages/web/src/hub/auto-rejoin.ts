/**
 * Auto-rejoin policy for the hub session surface.
 *
 * The relay treats "room gone" and host-conflict/full closes as fatal and the
 * vendored client never retries them, but inside the hub those closes are
 * usually transient: a hub restart outruns the agent's re-registration, or the
 * host child is mid-reconnect — the room comes back while the registry record
 * still reads `live`. While the polled registry says live, the surface
 * re-joins with capped exponential backoff and shows the reconnecting banner
 * instead of the ended card; a registry flip to exited/failed ends the loop
 * and restores the end card.
 */
import type { ConnectionPhase } from "../lib/client";

/** Delay before rejoin attempt `attempt` (0-based); capped so a wedged room retries quietly. */
export function rejoinDelayMs(attempt: number): number {
	return Math.min(1_000 * 2 ** Math.max(0, attempt), 15_000);
}

/** True when an ended client should silently re-join (registry still live). */
export function shouldAutoRejoin(phase: ConnectionPhase, registryLive: boolean): boolean {
	return phase === "ended" && registryLive;
}
