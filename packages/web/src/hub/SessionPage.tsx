/**
 * `/s/<id>` session page: pull the record from the hub API, wait out `starting`,
 * then hand the full collab link to {@link SessionView}.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { errorText, getDisplayName, getSession, type SessionRecord } from "./api";
import { navigate } from "./router";
import { SessionView } from "./SessionView";

export interface SessionPageProps {
	id: string;
}

export function SessionPage({ id }: SessionPageProps): ReactNode {
	const [record, setRecord] = useState<SessionRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	// Poll while `starting`; a live session streams over the collab socket itself.
	useEffect(() => {
		let cancelled = false;
		let timer: Timer | null = null;
		const load = async (): Promise<void> => {
			try {
				const next = await getSession(id);
				if (cancelled) return;
				setRecord(next);
				setError(null);
				setLoaded(true);
				if (next.status === "starting") timer = setTimeout(() => void load(), 3000);
			} catch (err) {
				if (cancelled) return;
				setError(errorText(err));
				setLoaded(true);
			}
		};
		void load();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [id]);

	if (record?.status === "live" && record.links) {
		return (
			<SessionView
				sessionId={record.id}
				link={record.links.full}
				record={record}
				displayName={getDisplayName()}
				onLeave={() => navigate("/")}
			/>
		);
	}

	return (
		<div className="sh-connect">
			<div className="sh-connect-card hb-card-center">
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span className="sh-lockup-pi">π</span> omp hub
					</div>
				</div>
				{!loaded && <div className="sh-connect-sub">Loading session…</div>}
				{loaded && error && (
					<>
						<div className="hb-card-title">Session unavailable</div>
						<div className="sh-connect-error" role="alert">
							{error}
						</div>
						<div className="hb-card-note">the session may have been pruned, or the id is wrong</div>
					</>
				)}
				{record && (
					<>
						<div className="hb-card-title">{record.name}</div>
						<div className="hb-card-note hb-mono">{record.cwd}</div>
						{record.status === "starting" && <div className="sh-connect-sub">Starting session…</div>}
						{record.status === "failed" && (
							<>
								<div className="sh-connect-error" role="alert">
									{record.error ?? "start failed"}
								</div>
								<div className="hb-card-note">on {record.machineName}</div>
							</>
						)}
						{record.status === "exited" && (
							<>
								<div className="sh-connect-sub">Session exited{record.exitReason ? ` — ${record.exitReason}` : ""}</div>
								<div className="hb-card-note">on {record.machineName}</div>
							</>
						)}
					</>
				)}
				<button type="button" className="sh-btn hb-back" onClick={() => navigate("/")}>
					Back to hub
				</button>
			</div>
		</div>
	);
}
