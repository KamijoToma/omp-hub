/**
 * `/rewind` — move the session tree leaf back to an earlier user prompt (the
 * web analogue of the TUI's esc-esc): the target prompt and everything after it
 * leave the active branch, and the prompt text comes back as the draft. The
 * host confirms the move through `POST /api/sessions/:id/tree`; the transcript
 * is then truncated locally (the host broadcasts no tree-change frame, and a
 * reconnect always resyncs from the full snapshot).
 */
import { History, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { GuestClient, Notice } from "../lib/client";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CustomMessageEntry, type MessageEntry, type SessionEntry } from "../lib/wire";
import { errorText, navigateTree, type NavigateTreeResult } from "./api";
import { Modal } from "./Modal";

export interface RewindPickerProps {
	sessionId: string;
	/** The live guest replica — truncated on success. */
	client: GuestClient;
	entries: readonly SessionEntry[];
	/** Agent turn in flight; rewinding aborts it. */
	working: boolean;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

export interface RewindTarget {
	entry: MessageEntry | CustomMessageEntry;
	/** Entries that leave the active branch when rewinding past this message. */
	droppedCount: number;
	preview: string;
}

function entryPreview(entry: MessageEntry | CustomMessageEntry): string {
	const content = entry.type === "message" ? entry.message.content : entry.content;
	const text = typeof content === "string" ? content : (content.find(block => block.type === "text")?.text ?? "");
	return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** A rewind can target a real user prompt or a collab guest prompt; nothing else. */
function isRewindable(entry: SessionEntry): entry is MessageEntry | CustomMessageEntry {
	if (entry.type === "custom_message") return entry.customType === COLLAB_PROMPT_MESSAGE_TYPE;
	return entry.type === "message" && entry.message.role === "user" && !entry.message.synthetic;
}

/**
 * User messages and collab prompts on the current branch, newest first.
 *
 * The replica is the active branch in append order (snapshot + `entry` frames),
 * so a backwards array walk is the branch walk. The `parentId` chain is NOT
 * walkable here: the host drops non-wire entries (`custom` HUD notes,
 * `model_usage`, …) from the snapshot, leaving holes that cut the chain right
 * after the leaf and made `/rewind` report "nothing to rewind" on every real
 * session.
 */
export function rewindTargets(entries: readonly SessionEntry[]): RewindTarget[] {
	const targets: RewindTarget[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (!isRewindable(entry)) continue;
		targets.push({ entry, droppedCount: entries.length - i, preview: entryPreview(entry) });
	}
	return targets;
}

/** Entry id → the turn prompt a "rewind here" action targets: the nearest rewindable entry at or before it. */
export function rewindTargetMap(entries: readonly SessionEntry[]): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	let current: string | null = null;
	for (const entry of entries) {
		if (isRewindable(entry)) current = entry.id;
		if (current !== null) map.set(entry.id, current);
	}
	return map;
}

export type RewindOutcomeKind = "moved" | "aborted" | "cancelled" | "error";

/** User-facing result of one rewind; `message` is final copy for every kind. */
export interface RewindOutcome {
	kind: RewindOutcomeKind;
	message: string;
}

/**
 * One rewind, shared by the `/rewind` picker and the transcript's per-turn
 * "rewind here" button: move the host leaf via `POST /api/sessions/:id/tree`,
 * then truncate the local replica (the host broadcasts no tree-change frame).
 * Never throws — failures come back as `{kind: "error"}`.
 */
export async function rewindToEntry(
	sessionId: string,
	client: GuestClient,
	entries: readonly SessionEntry[],
	entryId: string,
): Promise<RewindOutcome> {
	const entry = entries.find(candidate => candidate.id === entryId);
	const fallbackPreview = entry && isRewindable(entry) ? entryPreview(entry) : "";
	let result: NavigateTreeResult;
	try {
		result = await navigateTree(sessionId, entryId);
	} catch (err) {
		return { kind: "error", message: errorText(err) };
	}
	if (result.cancelled) {
		return result.aborted
			? { kind: "aborted", message: "the agent turn was aborting — try again in a moment" }
			: { kind: "cancelled", message: "a session hook cancelled the rewind" };
	}
	client.dropEntriesFrom(entryId);
	const draft = result.editorText?.trim() || fallbackPreview;
	return {
		kind: "moved",
		message: draft ? `rewound — draft restored: ${draft.slice(0, 80)}` : "rewound",
	};
}

export function RewindPicker({ sessionId, client, entries, working, notify, onClose }: RewindPickerProps): ReactNode {
	const targets = useMemo(() => rewindTargets(entries), [entries]);
	const [selected, setSelected] = useState<RewindTarget | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const rewind = (): void => {
		if (!selected) return;
		setPending(true);
		setError(null);
		void rewindToEntry(sessionId, client, entries, selected.entry.id).then(outcome => {
			// Success closes; every failure keeps the modal up with inline copy.
			if (outcome.kind === "moved") {
				notify("info", outcome.message);
				onClose();
				return;
			}
			setPending(false);
			setError(outcome.message);
		});
	};

	return (
		<Modal title="Rewind" onClose={onClose}>
			{working && (
				<div className="hb-modal-error" role="alert">
					agent is running — rewinding aborts the current turn
				</div>
			)}
			{error && (
				<div className="hb-modal-error" role="alert">
					{error}
				</div>
			)}
			{targets.length === 0 ? (
				<p className="hb-empty">nothing to rewind yet</p>
			) : selected ? (
				<>
					<p className="hb-rewind-confirm">
						rewind to “{selected.preview || "this prompt"}”? {selected.droppedCount}{" "}
						{selected.droppedCount === 1 ? "entry leaves" : "entries leave"} the active branch, including the
						selected prompt (kept in the session file).
					</p>
					<div className="hb-rewind-actions">
						<button type="button" className="hb-rewind-go" onClick={rewind} disabled={pending}>
							{pending && <LoaderCircle size={13} className="hb-spin" aria-hidden="true" />} rewind
						</button>
						<button type="button" className="hb-rewind-back" onClick={() => setSelected(null)} disabled={pending}>
							back
						</button>
					</div>
				</>
			) : (
				<ul className="hb-rewind-list">
					{targets.map(target => (
						<li key={target.entry.id}>
							<button
								type="button"
								className="hb-pick-row"
								onClick={() => setSelected(target)}
								disabled={pending}
							>
								<History size={13} className="hb-rewind-icon" aria-hidden="true" />
								<span className="hb-rewind-text">{target.preview || "(empty prompt)"}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</Modal>
	);
}
