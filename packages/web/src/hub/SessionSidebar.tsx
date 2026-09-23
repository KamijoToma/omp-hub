/**
 * Quick session switching for the hub session page (the web `/resume`-style
 * picker for hub sessions, plus a persistent sidebar).
 *
 * Two surfaces share one polled `/api/sessions` listing:
 *
 * - {@link SessionSidebar}: a drawer docked into `.sh-main` on desktop and an
 *   overlay on phones (≤768px, mirroring the agents rail), with a back-to-hub
 *   button.
 * - {@link SessionSwitcherModal}: the `/sessions` dialog (Ctrl+K), a filtered
 *   picker in the shared modal shell.
 *
 * Picking a session is plain `navigate` to `/s/<id>`: the keyed SessionPage
 * remount closes the old collab client and dials the next room, so switching
 * never touches the agent-side session.
 */
import { Home, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { relTime, shortenPath } from "../lib/format";
import type { SessionRecord, SessionStatus } from "./api";
import { errorText, getSessions } from "./api";
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
function useHubSessions(): { sessions: SessionRecord[] | null; error: string | null } {
	const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);

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
	}, []);

	return { sessions, error };
}

interface PickerBodyProps {
	/** `null` until the first poll lands; rows stay up on later poll errors. */
	sessions: SessionRecord[] | null;
	error: string | null;
	currentId: string;
	/** Receives the picked record; owners decide navigation. */
	onPick(session: SessionRecord): void;
}

/** Filter input + session rows, shared by the drawer and the switcher dialog. */
function PickerBody({ sessions, error, currentId, onPick }: PickerBodyProps): ReactNode {
	const [filter, setFilter] = useState("");
	const filtered = useMemo(() => filterHubSessions(sessions ?? [], filter), [sessions, filter]);

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
						return (
							<li key={session.id}>
								<button
									type="button"
									className={current ? "hb-nav-row hb-nav-current" : "hb-nav-row"}
									aria-current={current ? "page" : undefined}
									onClick={() => onPick(session)}
									title={current ? "current session" : `open ${session.name}`}
								>
									<span className="hb-nav-row-head">
										<span className={`hb-dot hb-dot-${session.status}`} aria-label={STATUS_LABEL[session.status]} />
										<span className="hb-nav-name">{session.name}</span>
										{session.status !== "live" && <span className="hb-status">{STATUS_LABEL[session.status]}</span>}
									</span>
									<span className="hb-nav-meta">
										<span className="hb-mono" title={session.cwd}>
											{shortenPath(session.cwd)}
										</span>
										<span className="hb-mono">{session.machineName}</span>
										<span className="hb-mono">{relTime(session.startedAt)}</span>
									</span>
								</button>
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
}

/** The docked/overlay session drawer. */
export function SessionSidebar({ currentId, onHome, onClose, onSwitch }: SessionSidebarProps): ReactNode {
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
		<>
			<div className="hb-nav-backdrop" onClick={onClose} />
			<aside className="hb-nav" aria-label="sessions">
				<div className="hb-nav-head">
					<button type="button" className="sh-btn" onClick={onHome} title="back to the hub home">
						<Home size={13} aria-hidden="true" />
						<span className="sh-btn-label">Hub</span>
					</button>
					<span className="hb-nav-title">Sessions</span>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} title="close (Esc)">
						<X size={13} aria-hidden="true" />
					</button>
				</div>
				<div className="hb-nav-body">
					<PickerBody sessions={sessions} error={error} currentId={currentId} onPick={pick} />
				</div>
			</aside>
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
