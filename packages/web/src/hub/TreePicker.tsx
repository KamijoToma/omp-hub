/**
 * `/tree` — browse the host's full session tree and move the active leaf to any
 * node (the web analogue of the TUI's `/tree` selector). The guest replica
 * cannot render this view: pruned non-wire entries leave holes in its parent
 * chains, so the structure comes from the agent's `get-tree`. A leaf move
 * re-points which branch the host appends to and broadcasts no frame, so
 * success triggers a full reconnect resync instead of a local truncation.
 */
import { GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { errorText, getSessionTree, navigateTree, type SessionTree, type TreeWireNode } from "./api";
import { Modal } from "./Modal";

export interface TreePickerProps {
	sessionId: string;
	/** Full reconnect after a leaf move — the only way a guest resyncs a branch switch. */
	onResync(): void;
	notify(level: "info" | "warning" | "error", message: string): void;
	onClose(): void;
}

interface FlatNode {
	node: TreeWireNode;
	depth: number;
}

/** DFS pre-order, matching the host's parents-before-children serialization. */
function flattenTree(nodes: readonly TreeWireNode[], depth = 0, out: FlatNode[] = []): FlatNode[] {
	for (const node of nodes) {
		out.push({ node, depth });
		flattenTree(node.children, depth + 1, out);
	}
	return out;
}

function TreeNodeRow({ flat, disabled, onPick }: { flat: FlatNode; disabled: boolean; onPick(node: TreeWireNode): void }): ReactNode {
	const { node, depth } = flat;
	const isPrompt =
		node.type === "message" ? node.role === "user" : node.type === "custom_message" && node.customType === "collab-prompt";
	return (
		<li style={{ paddingLeft: depth * 14 }}>
			<button
				type="button"
				className={`hb-pick-row hb-tree-row${node.branch ? " hb-tree-row--branch" : ""}${node.leaf ? " hb-pick-row-current" : ""}`}
				onClick={() => onPick(node)}
				disabled={disabled}
			>
				<GitBranch size={12} className="hb-tree-icon" aria-hidden="true" />
				<span className={`hb-tree-text${isPrompt ? "" : " hb-tree-text--dim"}`}>
					{node.preview || `(${node.type}${node.toolName ? ` ${node.toolName}` : ""})`}
				</span>
				{node.leaf && <span className="hb-tree-chip">leaf</span>}
				{node.label && <span className="hb-tree-chip hb-tree-chip--label">{node.label}</span>}
			</button>
		</li>
	);
}

export function TreePicker({ sessionId, onResync, notify, onClose }: TreePickerProps): ReactNode {
	const [tree, setTree] = useState<SessionTree | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<TreeWireNode | null>(null);
	const [pending, setPending] = useState(false);

	const load = useCallback((): void => {
		setLoading(true);
		setError(null);
		void getSessionTree(sessionId).then(
			next => {
				setTree(next);
				setLoading(false);
			},
			(err: unknown) => {
				setError(errorText(err));
				setLoading(false);
			},
		);
	}, [sessionId]);

	useEffect(load, [load]);

	const move = (): void => {
		if (!selected) return;
		setPending(true);
		setError(null);
		void navigateTree(sessionId, selected.id).then(
			result => {
				if (result.cancelled) {
					setPending(false);
					setError(
						result.aborted ? "the agent turn was aborting — try again in a moment" : "a session hook cancelled the move",
					);
					return;
				}
				const draft = result.editorText?.trim();
				notify("info", draft ? `leaf moved — draft restored: ${draft.slice(0, 80)}` : "leaf moved — resyncing transcript");
				onClose();
				onResync();
			},
			(err: unknown) => {
				setPending(false);
				setError(errorText(err));
			},
		);
	};

	const flat = tree ? flattenTree(tree.nodes) : [];

	return (
		<Modal title="Session tree" onClose={onClose}>
			{error && (
				<div className="hb-modal-error" role="alert">
					{error}
				</div>
			)}
			{loading ? (
				<p className="hb-empty">
					<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading tree…
				</p>
			) : selected ? (
				<>
					<p className="hb-rewind-confirm">
						move the leaf to “{selected.preview || `this ${selected.type}`}”? Everything after it leaves the
						active branch{selected.branch ? "" : " (it is on an abandoned branch and comes back)"}. The
						transcript resyncs from the host.
					</p>
					<div className="hb-rewind-actions">
						<button type="button" className="hb-rewind-go" onClick={move} disabled={pending}>
							{pending && <LoaderCircle size={13} className="hb-spin" aria-hidden="true" />} move leaf
						</button>
						<button type="button" className="hb-rewind-back" onClick={() => setSelected(null)} disabled={pending}>
							back
						</button>
					</div>
				</>
			) : (
				<>
					<div className="hb-tree-toolbar">
						<span className="hb-card-note">
							{flat.length} {flat.length === 1 ? "entry" : "entries"}
							{tree?.truncated ? " · truncated by the host's node cap" : ""} · highlighted spine is the active
							branch
						</span>
						<button type="button" className="sh-btn" onClick={load} disabled={loading} title="reload">
							<RefreshCw size={12} aria-hidden="true" />
							<span className="sh-btn-label">Reload</span>
						</button>
					</div>
					<ul className="hb-pick-list hb-tree-list">
						{flat.map(flatNode => (
							<TreeNodeRow key={flatNode.node.id} flat={flatNode} disabled={pending} onPick={setSelected} />
						))}
					</ul>
				</>
			)}
		</Modal>
	);
}
