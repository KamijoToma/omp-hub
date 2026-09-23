/**
 * Quick session switching for the hub session page (the web `/resume`-style
 * picker for hub sessions, plus a persistent sidebar).
 *
 * Two surfaces share one polled `/api/sessions` listing:
 *
 * - {@link SessionSidebar}: a drawer docked into `.sh-main` on desktop and an
 *   overlay on phones (≤768px, mirroring the agents rail), with a back-to-hub
 *   button, a cross-session alert toggle, and per-row rename.
 * - {@link SessionSwitcherModal}: the `/sessions` dialog (Ctrl+K), a filtered
 *   picker in the shared modal shell.
 *
 * Picking a session is plain `navigate` to `/s/<id>`: the keyed SessionPage
 * remount closes the old collab client and dials the next room, so switching
 * never touches the agent-side session. `working`/`inputRequired` come from
 * the record's mirrored `activity` (protocol §3) — absent on older agents.
 */
import { Bell, BellOff, Home, Pencil, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relTime, shortenPath } from "../lib/format";
import type { SessionRecord, SessionStatus } from "./api";
import { errorText, getSessions, postRename } from "./api";
import { Modal } from "./Modal";
import { navigate } from "./router";

/** Hub registry poll cadence; matches the hub home's session list. */
const POLL_MS = 2000;

const STATUS_LABEL: Record<SessionStatus, string> = {
	starting: "starting",
	live: "live",
	exited: "exited",
	failed: "failed",
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

/** Polled `/api/sessions` mirror; polls only while mounted, keeps stale rows on transient errors. */
function useHubSessions(): { sessions: SessionRecord[] | null; error: string | null; refresh(): void } {
	const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Bumping refetches immediately (post-rename) instead of waiting a tick.
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		const tick = (): void => {
			getSessions().then(
				next => {
					if (cancelled) return;
					setSessions(next);
					setError(null);
				},
				(err: unknown) => {
					if (!cancelled) setError(errorText(err));
				},
			);
		};
		tick();
		const timer = setInterval(tick, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [attempt]);

	return { sessions, error, refresh: useCallback(() => setAttempt(n => n + 1), []) };
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
	sessions: SessionRecord[] | null;
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

/** Filter input + session rows, shared by the drawer and the switcher dialog. */
function PickerBody({ sessions, error, currentId, onPick, onRename }: PickerBodyProps): ReactNode {
	const [filter, setFilter] = useState("");
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
						const badge = session.activity?.inputRequired === true ? "input" : session.activity?.working === true ? "working" : null;
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

export interface SessionSidebarProps {
	/** Session the page is currently attached to, highlighted and unpickable. */
	currentId: string;
	/** Back-to-hub action; the page's existing leave path. */
	onHome(): void;
	/** Closes the drawer (backdrop, X, picking the current session). */
	onClose(): void;
	/** Switches to another session; the page owns navigation and warnings. */
	onSwitch(sessionId: string): void;
	/** Cross-session alert toggle state (persisted; see `session-alerts.ts`). */
	alertsOn: boolean;
	/** Flips the alert toggle; the page owns permission prompting and polling. */
	onToggleAlerts(): void;
}

/** The docked/overlay session drawer. */
export function SessionSidebar({ currentId, onHome, onClose, onSwitch, alertsOn, onToggleAlerts }: SessionSidebarProps): ReactNode {
	const { sessions, error, refresh } = useHubSessions();
	const [renaming, setRenaming] = useState<SessionRecord | null>(null);
	// The rename dialog must survive list refreshes (the poll replaces record
	// objects), so it re-reads the fresh record by id.
	const renamingRef = useRef<SessionRecord | null>(null);
	renamingRef.current = renaming;

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

	const openRename = useCallback((session: SessionRecord): void => {
		if (session.status !== "live") return;
		setRenaming(session);
	}, []);

	return (
		<>
			<div className="hb-nav-backdrop" onClick={onClose} />
			<aside className="hb-nav" aria-label="sessions">
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
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} title="close (Esc)">
						<X size={13} aria-hidden="true" />
					</button>
				</div>
				<div className="hb-nav-body">
					<PickerBody sessions={sessions} error={error} currentId={currentId} onPick={pick} onRename={openRename} />
				</div>
			</aside>
			{renaming !== null && (
				<RenameSessionModal
					session={sessions?.find(record => record.id === renaming.id) ?? renaming}
					onRenamed={refresh}
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
	const { sessions, error } = useHubSessions();

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
