/**
 * Client-side steering messages for the session view, mirroring the TUI
 * input-controller semantics: a prompt submitted while the host agent streams
 * is queued host-side as a steering message — it interrupts the run at the
 * next tool-use boundary, or rides along until the turn ends. The wire only
 * mirrors `state.queuedMessageCount`, so the submitted texts are recorded here
 * for display until the matching `collab-prompt` entry lands, the host queue
 * drains, or the connection leaves the live phase. Re-submitting with an empty
 * editor sends `abort`, which interrupts the turn immediately and lets the
 * host's post-abort drain deliver the queued messages.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { GuestSnapshot } from "../lib/client";
import { COLLAB_PROMPT_MESSAGE_TYPE, type SessionEntry } from "../lib/wire";

export interface PendingSteer {
	/** Verbatim submitted text. */
	text: string;
	/** `entries.length` when queued; delivery matching only scans at or after this index. */
	cursor: number;
}

/** Text of a delivered collab guest prompt entry, or undefined for anything else. */
export function collabPromptEntryText(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom_message" || entry.customType !== COLLAB_PROMPT_MESSAGE_TYPE) return undefined;
	if (typeof entry.content === "string") return entry.content;
	return entry.content.find(block => block.type === "text")?.text;
}

/**
 * Drop pending steers whose text matches a delivered entry at or after the
 * index recorded at queue time. The first match consumes the oldest pending
 * entry, so duplicate texts settle in submission order.
 */
export function reconcilePendingSteers(
	pending: readonly PendingSteer[],
	entries: readonly SessionEntry[],
): readonly PendingSteer[] {
	if (pending.length === 0) return pending;
	const remaining = [...pending];
	const from = Math.max(0, Math.min(...remaining.map(item => item.cursor)));
	for (let i = from; i < entries.length && remaining.length > 0; i++) {
		const text = collabPromptEntryText(entries[i]!);
		if (text === undefined) continue;
		const index = remaining.findIndex(item => item.cursor <= i && item.text === text);
		if (index >= 0) remaining.splice(index, 1);
	}
	return remaining;
}

/**
 * Settle the recorded steers against the current snapshot: everything clears
 * when the connection leaves the live phase (a fresh welcome resets the
 * transcript replica, voiding recorded cursors) or when the host went idle
 * with an empty queue, and delivered messages drop individually otherwise.
 */
export function settlePendingSteers(
	recorded: readonly PendingSteer[],
	snap: Pick<GuestSnapshot, "phase" | "working" | "state" | "entries">,
): readonly PendingSteer[] {
	if (recorded.length === 0) return recorded;
	if (snap.phase !== "live") return [];
	const busy = snap.working || (snap.state?.isStreaming ?? false);
	if (!busy && (snap.state?.queuedMessageCount ?? 0) === 0) return [];
	return reconcilePendingSteers(recorded, snap.entries);
}

export interface SteeringQueue {
	readonly pending: readonly PendingSteer[];
	/** Host-queued messages this guest did not submit (other peers, host TUI). */
	readonly extraQueued: number;
	/** Record a text just handed to the host while the agent was streaming. */
	recordQueued(text: string): void;
}

export function useSteeringQueue(snap: GuestSnapshot): SteeringQueue {
	const [recorded, setRecorded] = useState<readonly PendingSteer[]>([]);
	// Latest transcript length; read at record time so delivery matching only
	// scans entries appended after the steer was queued.
	const cursorRef = useRef(0);
	cursorRef.current = snap.entries.length;

	const pending = useMemo(() => settlePendingSteers(recorded, snap), [recorded, snap]);
	const extraQueued = Math.max(0, (snap.state?.queuedMessageCount ?? 0) - pending.length);

	const recordQueued = useCallback((text: string): void => {
		setRecorded(prev => [...prev, { text, cursor: cursorRef.current }]);
	}, []);

	return { pending, extraQueued, recordQueued };
}
