/**
 * `/rewind` — move the session tree leaf back to an earlier user message (the
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
import type { MessageEntry, SessionEntry } from "../lib/wire";
import { errorText, navigateTree } from "./api";
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
	entry: MessageEntry;
	/** Entries that leave the active branch when rewinding past this message. */
	droppedCount: number;
	preview: string;
}

function entryPreview(entry: MessageEntry): string {
	const { content } = entry.message;
	const text = typeof content === "string" ? content : (content.find(block => block.type === "text")?.text ?? "");
	return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** User messages on the current branch, newest first (append order ends at the leaf). */
export function rewindTargets(entries: readonly SessionEntry[]): RewindTarget[] {
	if (entries.length === 0) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const targets: RewindTarget[] = [];
	// Walk parent links from the last appended entry (the leaf) back to the root.
	for (let cur: SessionEntry | undefined = entries[entries.length - 1]; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
		if (cur.type !== "message") continue;
		const message = cur.message;
		if (message.role !== "user" || message.synthetic) continue;
		targets.push({
			entry: cur,
			droppedCount: entries.length - entries.indexOf(cur),
			preview: entryPreview(cur),
		});
	}
	return targets;
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
		void navigateTree(sessionId, selected.entry.id).then(
			result => {
				if (result.cancelled) {
					setPending(false);
					setError(result.aborted ? "the agent turn was aborting — try again in a moment" : "a session hook cancelled the rewind");
					return;
				}
				client.dropEntriesFrom(selected.entry.id);
				const draft = result.editorText?.trim() || selected.preview;
				notify("info", draft ? `rewound — draft restored: ${draft.slice(0, 80)}` : "rewound");
				onClose();
			},
			(err: unknown) => {
				setPending(false);
				setError(errorText(err));
			},
		);
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
						rewind to “{selected.preview || "this prompt"}”? {selected.droppedCount} later{" "}
						{selected.droppedCount === 1 ? "entry leaves" : "entries leave"} the active branch (kept in the
						session file).
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
