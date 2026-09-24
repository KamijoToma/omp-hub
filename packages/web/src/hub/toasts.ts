/**
 * Module-level toast store for the session surface's local notices (command
 * outcomes, switch warnings). Survives surface remounts, so a notice fired
 * right before an in-page navigation ("new session started") is still shown
 * afterwards. Rendered by the vendored `Toasts`, which auto-dismisses by
 * `Notice.at`; ids live above the client's notice sequence (which starts at 1)
 * so merged lists never collide.
 */
import { useSyncExternalStore } from "react";
import type { Notice } from "../lib/client";

const LOCAL_NOTICE_BASE = 1_000_000;
const MAX_LOCAL_NOTICES = 20;

let seq = 0;
let notices: readonly Notice[] = [];
const listeners = new Set<() => void>();
let snapshot: readonly Notice[] = notices;

function emit(): void {
	snapshot = notices;
	for (const listener of listeners) listener();
}

/** Push a local toast (`info` | `warning` | `error`). */
export function pushToast(level: Notice["level"], message: string): void {
	seq += 1;
	const next = [...notices, { id: LOCAL_NOTICE_BASE + seq, level, message, at: Date.now() }];
	notices = next.length > MAX_LOCAL_NOTICES ? next.slice(-MAX_LOCAL_NOTICES) : next;
	emit();
}

export function useLocalToasts(): readonly Notice[] {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}
