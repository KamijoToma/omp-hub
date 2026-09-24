/**
 * Session rail for the session page: a two-state drawer on the frame's left
 * edge (the frame itself lives in {@link SessionPage}).
 *
 * - Collapsed (default): a 44px icon strip that is always present — one glyph
 *   per session with a live status dot (`working`/`input` from the record's
 *   mirrored `activity`, protocol §3). Clicking a glyph switches sessions.
 * - Expanded: the full picker — filter, names, cwd/machine/time meta, per-row
 *   rename, the cross-session alert bell, and the back-to-hub button.
 *
 * The listing comes from the shared sessions store, so collapsed dots stay
 * live without opening the drawer. `SessionSwitcherModal` (the `/sessions`
 * slash command and Ctrl+K dialog) shares the picker body.
 */
import { Bell, BellOff, Home, PanelLeftClose, PanelLeftOpen, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { relTime, shortenPath } from "../lib/format";
import type { SessionRecord, SessionStatus } from "./api";
import { errorText, postRename } from "./api";
import { Modal } from "./Modal";
import { sessionsStore, useSessions } from "./sessions-store";
import { useCompletedSessions } from "./rail-completion";

const STATUS_LABEL: Record<SessionStatus, string> = {
	starting: "starting",
	live: "live",
	exited: "exited",
	failed: "failed",
};

/** Dot states beyond the registry status: activity refinements + local completion. */
type RailDotState = SessionStatus | "input" | "working" | "done";

const DOT_LABEL: Record<RailDotState, string> = {
	...STATUS_LABEL,
	input: "needs input",
	working: "working",
	done: "task completed",
};

/**
 * Filter a hub session listing: case-insensitive substring on name, cwd,
 * machine, id, or profile. An absent profile reads as `"default"`, matching
 * the resume picker and the hub home's history filter.
 */
export function filterHubSessions(sessions: readonly SessionRecord[], query: string): SessionRecord[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...sessions];
	return sessions.filter(
		session =>
			session.name.toLowerCase().includes(needle) ||
			session.cwd.toLowerCase().includes(needle) ||
			session.machineName.toLowerCase().includes(needle) ||
			session.id.toLowerCase().includes(needle) ||
			(session.profile ?? "default").toLowerCase().includes(needle),
	);
}

interface RenameSessionModalProps {
	session: SessionRecord;
	/** Fired after the hub accepted the rename; the owner refreshes the list. */
	onRenamed(): void;
	onClose(): void;
}

/** Small dialog behind the row pencil / right-click: one input, one submit. */
function RenameSessionModal({ session, onRenamed, onClose }: RenameSessionModalProps): ReactNode {
	const [name, setName] = useState(session.name);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = useCallback((): void => {
		const trimmed = name.trim();
		if (trimmed === "") {
			setError("name is required");
			return;
		}
		if (trimmed === session.name) {
			onClose();
			return;
		}
		setBusy(true);
		postRename(session.id, trimmed).then(
			() => {
				onRenamed();
				onClose();
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(err));
			},
		);
	}, [name, session.id, session.name, onRenamed, onClose]);

	return (
		<Modal title="Rename session" onClose={onClose}>
			<form
				className="hb-rename-form"
				onSubmit={e => {
					e.preventDefault();
					submit();
				}}
			>
				<input
					className="sh-input"
					type="text"
					value={name}
					onChange={e => setName(e.target.value)}
					placeholder="session name"
					spellCheck={false}
					autoComplete="off"
					autoFocus
					disabled={busy}
				/>
				{error && (
					<p className="hb-session-error" role="alert">
						{error}
					</p>
				)}
				<button type="submit" className="sh-btn sh-btn-primary" disabled={busy || name.trim() === ""}>
					Rename
				</button>
			</form>
		</Modal>
	);
}

interface PickerBodyProps {
	/** `null` until the first poll lands; rows stay up on later poll errors. */
	sessions: readonly SessionRecord[] | null;
	error: string | null;
	currentId: string;
	/** Receives the picked record; owners decide navigation. */
	onPick(session: SessionRecord): void;
	/**
	 * Opens the rename dialog for a live session (pencil / right-click).
	 * Left unset in the quick switcher, where renaming is out of scope.
	 */
	onRename?(session: SessionRecord): void;
}

/** Filter input + session rows, shared by the expanded rail and the switcher dialog. */
function PickerBody({ sessions, error, currentId, onPick, onRename }: PickerBodyProps): ReactNode {
	const [filter, setFilter] = useState("");
	const completedSet = useCompletedSessions();
	const filtered = useMemo(() => filterHubSessions(sessions ?? [], filter), [sessions, filter]);
	const renames = onRename !== undefined;

	return (
		<>
			<input
				className="sh-input hb-history-filter"
				type="text"
				value={filter}
				onChange={e => setFilter(e.target.value)}
				placeholder="filter by name, directory, machine, or profile"
				spellCheck={false}
				autoComplete="off"
			/>
			{sessions === null && !error && <p className="hb-empty">loading…</p>}
			{sessions === null && error && <p className="hb-empty">{error}</p>}
			{sessions !== null && filtered.length === 0 && <p className="hb-empty">no matching sessions</p>}
			{filtered.length > 0 && (
				<ul className="hb-nav-list">
					{filtered.map(session => {
						const current = session.id === currentId;
						const completed = completedSet.has(session.id);
						const badge =
							session.activity?.inputRequired === true
								? "input"
								: session.activity?.working === true
									? "working"
									: completed
										? "done"
										: null;
						return (
							<li key={session.id}>
								<div className={current ? "hb-nav-row-wrap hb-nav-current" : "hb-nav-row-wrap"}>
									<button
										type="button"
										className="hb-nav-row"
										aria-current={current ? "page" : undefined}
										onClick={() => onPick(session)}
										onContextMenu={e => {
											if (!renames || session.status !== "live") return;
											e.preventDefault();
											onRename(session);
										}}
										title={
											current
												? "current session"
												: session.status === "live" && renames
													? `open ${session.name} (right-click to rename)`
													: `open ${session.name}`
										}
									>
										<span className="hb-nav-row-head">
											<span className={`hb-dot hb-dot-${session.status}`} aria-label={STATUS_LABEL[session.status]} />
											<span className="hb-nav-name">{session.name}</span>
											{session.status !== "live" && <span className="hb-status">{STATUS_LABEL[session.status]}</span>}
											{badge !== null && <span className={`hb-nav-badge hb-nav-badge-${badge}`}>{badge}</span>}
										</span>
										<span className="hb-nav-meta">
											<span className="hb-mono" title={session.cwd}>
												{shortenPath(session.cwd)}
											</span>
											<span className="hb-mono">{session.machineName}</span>
											<span className="hb-mono">{relTime(session.startedAt)}</span>
										</span>
									</button>
									{renames && session.status === "live" && (
										<button
											type="button"
											className="hb-nav-rename"
											onClick={() => onRename(session)}
											title="rename session"
										>
											<Pencil size={12} aria-hidden="true" />
										</button>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}

// ---- collapsed strip ----

/** Stable hue per session id, so a project keeps its glyph color across reloads. */
function glyphHue(id: string): number {
	let hash = 0;
	for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
	return hash % 360;
}

/**
 * Collapsed-strip identity letter: the session's title (hub registry name,
 * auto-titled or user-set) wins so sessions in one repo stay distinguishable;
 * the project directory is the fallback for unnamed records.
 */
export function railGlyphLabel(session: SessionRecord): string {
	const name = session.name.trim();
	if (name !== "") return (name[0] ?? "?").toUpperCase();
	const base = session.cwd.split("/").filter(Boolean).pop();
	return (base?.[0] ?? "?").toUpperCase();
}

/** Collapsed-strip dot state: live sessions refine to activity + local completion. */
function railDotState(session: SessionRecord, completed: ReadonlySet<string>): RailDotState {
	if (session.status !== "live") return session.status;
	if (session.activity?.inputRequired === true) return "input";
	if (session.activity?.working === true) return "working";
	if (completed.has(session.id)) return "done";
	return "live";
}

function RailRow({ session, current, onSwitch }: { session: SessionRecord; current: boolean; onSwitch(id: string): void }): ReactNode {
	const label = railGlyphLabel(session);
	const completed = useCompletedSessions();
	const dot = railDotState(session, completed);
	const activity =
		session.activity?.inputRequired === true
			? " · needs input"
			: session.activity?.working === true
				? " · working"
				: dot === "done"
					? " · done"
					: "";
	return (
		<li>
			<button
				type="button"
				className={current ? "hb-rail-row hb-rail-current" : "hb-rail-row"}
				onClick={() => onSwitch(session.id)}
				aria-current={current ? "page" : undefined}
				title={`${session.name} · ${STATUS_LABEL[session.status]}${activity}`}
			>
				<span className="hb-rail-glyph" style={{ background: `hsl(${glyphHue(session.id)} 42% 40%)` }} aria-hidden="true">
					{label}
				</span>
				<span className={`hb-rail-dot hb-rail-dot-${dot}`} aria-label={DOT_LABEL[dot]} />
			</button>
		</li>
	);
}

export interface SessionRailProps {
	/** Session the page is currently attached to, highlighted and unpickable. */
	currentId: string;
	/** Expanded (full picker) vs collapsed (icon strip); state lives in the page frame. */
	expanded: boolean;
	onToggleExpanded(): void;
	/** Back-to-hub action; the page's existing leave path. */
	onHome(): void;
	/** Switches to another session; the page owns navigation and warnings. */
	onSwitch(sessionId: string): void;
	/** Cross-session alert toggle state (persisted; see `session-alerts.ts`). */
	alertsOn: boolean;
	/** Flips the alert toggle; the page owns permission prompting and polling. */
	onToggleAlerts(): void;
}

/** The docked/overlay session drawer: collapsed icon strip or the full picker. */
export function SessionRail({ currentId, expanded, onToggleExpanded, onHome, onSwitch, alertsOn, onToggleAlerts }: SessionRailProps): ReactNode {
	const { sessions, error } = useSessions();
	const [renaming, setRenaming] = useState<SessionRecord | null>(null);
	// The rename dialog must survive list refreshes (the poll replaces record
	// objects), so it re-reads the fresh record by id.
	const renamingRef = useRef<SessionRecord | null>(null);
	renamingRef.current = renaming;

	const pick = useCallback(
		(session: SessionRecord): void => {
			if (session.id === currentId) {
				onToggleExpanded();
				return;
			}
			onSwitch(session.id);
		},
		[currentId, onSwitch, onToggleExpanded],
	);

	const openRename = useCallback((session: SessionRecord): void => {
		if (session.status !== "live") return;
		setRenaming(session);
	}, []);

	return (
		<>
			{expanded && <div className="hb-rail-backdrop" onClick={onToggleExpanded} />}
			<aside className={expanded ? "hb-rail hb-rail-open" : "hb-rail"} aria-label="sessions">
				{expanded ? (
					<>
						<div className="hb-nav-head">
							<button type="button" className="sh-btn" onClick={onHome} title="back to the hub home">
								<Home size={13} aria-hidden="true" />
								<span className="sh-btn-label">Hub</span>
							</button>
							<span className="hb-nav-title">Sessions</span>
							<button
								type="button"
								className={alertsOn ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
								onClick={onToggleAlerts}
								title={alertsOn ? "session alerts on — click to mute" : "notify when a session needs input or exits"}
							>
								{alertsOn ? <Bell size={13} aria-hidden="true" /> : <BellOff size={13} aria-hidden="true" />}
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={onToggleExpanded}
								title="collapse (Esc)"
								aria-expanded="true"
							>
								<PanelLeftClose size={13} aria-hidden="true" />
							</button>
						</div>
						<div className="hb-nav-body">
							<PickerBody
								sessions={sessions}
								error={error}
								currentId={currentId}
								onPick={pick}
								onRename={openRename}
							/>
						</div>
					</>
				) : (
					<>
						<button
							type="button"
							className="hb-rail-toggle"
							onClick={onToggleExpanded}
							title="expand session list"
							aria-expanded="false"
						>
							<PanelLeftOpen size={14} aria-hidden="true" />
						</button>
						<ul className="hb-rail-list">
							{sessions === null && (
								<>
									<li>
										<span className="hb-rail-row hb-rail-skel" />
									</li>
									<li>
										<span className="hb-rail-row hb-rail-skel" />
									</li>
									<li>
										<span className="hb-rail-row hb-rail-skel" />
									</li>
								</>
							)}
							{(sessions ?? []).map(session => (
								<RailRow key={session.id} session={session} current={session.id === currentId} onSwitch={onSwitch} />
							))}
						</ul>
						<button type="button" className="hb-rail-home" onClick={onHome} title="back to the hub home">
							<Home size={14} aria-hidden="true" />
						</button>
					</>
				)}
			</aside>
			{renaming !== null && (
				<RenameSessionModal
					session={sessions?.find(record => record.id === renaming.id) ?? renaming}
					onRenamed={() => sessionsStore.refresh()}
					onClose={() => setRenaming(null)}
				/>
			)}
		</>
	);
}

export interface SessionSwitcherModalProps {
	currentId: string;
	onSwitch(sessionId: string): void;
	onClose(): void;
}

/** The `/sessions` dialog (also Ctrl+K): same rows in the shared modal shell. */
export function SessionSwitcherModal({ currentId, onSwitch, onClose }: SessionSwitcherModalProps): ReactNode {
	const { sessions, error } = useSessions();

	const pick = useCallback(
		(session: SessionRecord): void => {
			if (session.id === currentId) {
				onClose();
				return;
			}
			onSwitch(session.id);
		},
		[currentId, onClose, onSwitch],
	);

	return (
		<Modal title="Switch session" onClose={onClose}>
			<PickerBody sessions={sessions} error={error} currentId={currentId} onPick={pick} />
		</Modal>
	);
}
