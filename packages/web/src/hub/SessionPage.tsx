/**
 * Per-session pane mounted inside the shared hub frame. The keyed pane keeps
 * its attachment for this id across registry updates; an ended room can still
 * show its transcript, while a starting room polls until its link arrives.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Toasts } from "../components/shell/Toasts";
import { errorText, getDisplayName, restartSession, type SessionRecord } from "./api";
import { pushToast, useLocalToasts } from "./toasts";
import { relTime } from "../lib/format";
import { sessionsStore, useSessionRecord } from "./sessions-store";
import { clientPool } from "./client-pool";
import { SessionView } from "./SessionView";

export interface SessionPageProps {
	id: string;
	onLeave(): void;
	onOpenSwitcher(): void;
	onOpenSettings(): void;
}

/** Status cards have no collab surface to render settings/alert feedback. */
function StatusToasts(): ReactNode {
	return <Toasts notices={useLocalToasts()} />;
}

/**
 * In-place gate for sessions that cannot attach yet (or no more): rendered
 * inside the frame's content column — the rail stays interactive, and no
 * full-page card swap ever flashes over the shell.
 */
function SessionStatusCard({ id, record, loadError, onNew }: { id: string; record: SessionRecord | null; loadError: string | null; onNew(): void }): ReactNode {
	// Restart applies to the terminal branches below; `starting` needs no gate
	// (the button is not rendered there) and a successful restart unmounts the
	// card once the record flips live.
	const [restarting, setRestarting] = useState(false);
	const restart = useCallback((): void => {
		if (restarting) return;
		setRestarting(true);
		void restartSession(id).then(
			session => {
				// Instant flip to the "starting" surface; the store poll would
				// catch it too, but not before the next tick.
				sessionsStore.refreshSession(session.id);
			},
			(err: unknown) => pushToast("error", errorText(err)),
		).finally(() => setRestarting(false));
	}, [id, restarting]);
	return (
		<div className="hb-frame-status">
			<div className="hb-card hb-status-card">
				<div className="hb-card-title">{record?.name ?? "session"}</div>
				{record && <div className="hb-card-note hb-mono">{record.cwd}</div>}
				{record === null && loadError === null && (
					<>
						<div className="sh-connect-sub">Loading session…</div>
						<div className="hb-status-skel">
							<span className="hb-skel" />
							<span className="hb-skel" />
							<span className="hb-skel hb-skel-short" />
						</div>
					</>
				)}
				{record === null && loadError !== null && (
					<>
						<div className="hb-card-title">Session unavailable</div>
						<div className="sh-connect-error" role="alert">
							{loadError}
						</div>
						<div className="hb-card-note">the session may have been pruned, or the id is wrong</div>
						<button type="button" className="sh-btn hb-status-back" onClick={onNew}>
							New session
						</button>
					</>
				)}
				{record?.status === "starting" && <div className="sh-connect-sub">Starting session…</div>}
				{record?.status === "failed" && (
					<>
						<div className="sh-connect-error" role="alert">
							{record.error ?? "start failed"}
						</div>
						<div className="hb-card-note">on {record.machineName}</div>
						<div className="hb-status-actions">
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								onClick={restart}
								disabled={restarting}
								title="start again with the same directory and profile"
							>
								<RotateCcw size={13} className={restarting ? "hb-spin" : undefined} aria-hidden="true" />
								{restarting ? "restarting…" : "Retry start"}
							</button>
							<button type="button" className="sh-btn hb-status-back" onClick={onNew}>
								New session
							</button>
						</div>
					</>
				)}
				{record?.status === "exited" && (
					<>
						<div className="hb-card-note">
							exited{record.exitReason ? ` — ${record.exitReason}` : ""}
							{record.exitedAt ? ` · ${relTime(record.exitedAt)}` : ""}
						</div>
						<div className="hb-card-note">on {record.machineName}</div>
						<div className="hb-status-actions">
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								onClick={restart}
								disabled={restarting}
								title="restart under the same id — resumes this session's transcript"
							>
								<RotateCcw size={13} className={restarting ? "hb-spin" : undefined} aria-hidden="true" />
								{restarting ? "restarting…" : "Restart"}
							</button>
							<button type="button" className="sh-btn hb-status-back" onClick={onNew}>
								New session
							</button>
						</div>
					</>
				)}
			</div>
			<span className="hb-mono hb-status-id">{id}</span>
		</div>
	);
}

export function SessionPage({ id, onLeave, onOpenSwitcher, onOpenSettings }: SessionPageProps): ReactNode {
	const { record, error: loadError } = useSessionRecord(id);
	const displayName = useRef(getDisplayName()).current;

	// The frame keys this pane by id; retain its own last live attachment so
	// later registry transitions cannot replace the transcript with a status card.
	const [live, setLive] = useState<SessionRecord | null>(null);
	useEffect(() => {
		if (record === null || record.status !== "live" || record.links === undefined) return;
		const link = record.links.full;
		setLive(previous => {
			if (
				previous !== null &&
				previous.id === record.id &&
				previous.links?.full === link &&
				previous.name === record.name &&
				previous.cwd === record.cwd &&
				previous.profile === record.profile &&
				previous.machineId === record.machineId
			) {
				return previous;
			}
			return record;
		});
	}, [record]);

	const attached =
		record?.status === "live" && record.links
			? record
			: live?.id === id
				? live
				: record?.links && clientPool.peek(id)
					? record
					: null;

	// Unknown id: fetch its detail immediately; `starting`: fast-poll until links.
	useEffect(() => {
		if (record === null && loadError === null) void sessionsStore.refreshSession(id);
	}, [id, record, loadError]);
	useEffect(() => {
		if (record?.status !== "starting") return;
		const timer = setInterval(() => void sessionsStore.refreshSession(id), 1000);
		return () => clearInterval(timer);
	}, [id, record?.status]);

	return attached?.links ? (
		<SessionView
			sessionId={id}
			link={attached.links.full}
			record={attached}
			displayName={displayName}
			registryLive={record?.status === "live"}
			onLeave={onLeave}
			onOpenSwitcher={onOpenSwitcher}
			onOpenSettings={onOpenSettings}
		/>
	) : (
		<>
			<SessionStatusCard id={id} record={record} loadError={loadError} onNew={onLeave} />
			<StatusToasts />
		</>
	);
}
