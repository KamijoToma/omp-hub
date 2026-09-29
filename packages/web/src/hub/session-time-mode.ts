/**
 * Per-browser rail timestamp preference: picker rows show either the session's
 * registry creation time (`startedAt`) or its last activity (the mirrored
 * `activity.updatedAt`, falling back to exit/start). Stored in localStorage —
 * the hub registry is in-memory and shared by every guest, so the preference
 * must not live server-side. One toggle flips every row.
 */
import { useSyncExternalStore } from "react";
import type { SessionRecord } from "./api";

export type SessionTimeMode = "created" | "activity";

const KEY = "omp-hub.session-time-mode";

let mode: SessionTimeMode = load();
const listeners = new Set<() => void>();

/** Tolerant parser: anything but `"activity"` reads as the default. */
export function parseStoredMode(raw: string | null): SessionTimeMode {
	return raw === "activity" ? "activity" : "created";
}

function load(): SessionTimeMode {
	try {
		return parseStoredMode(globalThis.localStorage?.getItem(KEY) ?? null);
	} catch {
		return "created";
	}
}

function persist(): void {
	try {
		globalThis.localStorage?.setItem(KEY, mode);
	} catch {
		// Private mode / quota: the toggle still works for this page load.
	}
}

/** Set the timestamp mode from either the rail shortcut or settings center. */
export function setSessionTimeMode(next: SessionTimeMode): void {
	if (mode === next) return;
	mode = next;
	persist();
	for (const listener of listeners) listener();
}

export function toggleSessionTimeMode(): void {
	setSessionTimeMode(mode === "created" ? "activity" : "created");
}

/** Reactive view of the preference; updates across all consumers. */
export function useSessionTimeMode(): SessionTimeMode {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => mode,
		() => mode,
	);
}

/** Best "last activity" timestamp: the mirrored sample, else exit, else start. */
export function sessionActivityTime(
	session: Pick<SessionRecord, "activity" | "exitedAt" | "startedAt">,
): number {
	return session.activity?.updatedAt ?? session.exitedAt ?? session.startedAt;
}
