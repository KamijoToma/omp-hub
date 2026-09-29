import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { errorText, getNamespaces, HubApiError, setSessionNamespace, type NamespaceRecord, type SessionRecord } from "./api";
import { sessionsStore } from "./sessions-store";

/** Live-session fleet assignment; moving an existing transcript requires explicit consent. */
export function SessionNamespaceControl({ record }: { record: SessionRecord }): ReactNode {
	const [namespaces, setNamespaces] = useState<NamespaceRecord[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pending, setPending] = useState<SessionRecord | null>(null);
	const [target, setTarget] = useState(record.namespaceId ?? "");
	const [acknowledged, setAcknowledged] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void getNamespaces().then(
			found => {
				if (cancelled) return;
				setNamespaces(found);
				setLoadError(null);
			},
			(err: unknown) => {
				if (!cancelled) setLoadError(errorText(err));
			},
		);
		return () => { cancelled = true; };
	}, []);

	const session = pending && pending.membershipVersion > record.membershipVersion ? pending : record;
	const changed = target !== (session.namespaceId ?? "");
	const destination = namespaces?.find(ns => ns.id === target);
	const allowed = !destination || destination.machineIds === null || destination.machineIds.includes(session.machineId);
	const operatorChangeForbidden = session.superagent === true && changed && Boolean(target);

	const move = async (): Promise<void> => {
		if (!changed || busy || namespaces === null || !allowed || operatorChangeForbidden || (target !== "" && !acknowledged)) return;
		setBusy(true);
		setError(null);
		setFeedback(null);
		try {
			const updated = await setSessionNamespace(session.id, target || null, session.membershipVersion);
			setPending(updated);
			sessionsStore.refresh();
			setFeedback(target ? "Namespace updated" : "Removed from namespace");
		} catch (err) {
			setError(err instanceof HubApiError && err.status === 409
				? `Namespace assignment changed. ${errorText(err)} Refresh and retry.`
				: errorText(err));
			if (err instanceof HubApiError && err.status === 409) sessionsStore.refresh();
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="hb-namespace-control" aria-label={`fleet namespace for ${session.name}`}>
			<label className="sh-field">
				<span className="sh-field-label">assign / move live session</span>
				<select
					className="sh-input"
					aria-label={`namespace for ${session.name}`}
					value={target}
					disabled={namespaces === null || busy}
					onChange={e => { setTarget(e.target.value); setAcknowledged(false); setError(null); setFeedback(null); }}
				>
					<option value="">outside fleet (remove)</option>
					{namespaces?.map(ns => (
						<option key={ns.id} value={ns.id} disabled={ns.machineIds !== null && !ns.machineIds.includes(session.machineId)}>
							{ns.name}
						</option>
					))}
				</select>
			</label>
			{namespaces === null && !loadError && <p className="sh-field-hint">loading namespaces…</p>}
			{loadError && <div className="sh-connect-error" role="alert">{loadError}</div>}
			{changed && target && !operatorChangeForbidden && (
				<label className="sh-field-hint">
					<input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />
					{" "}I understand: moving this session exposes its existing conversation history and future messages to superagents in {destination?.name ?? target}. The previous controller loses new access, but already scheduled work may finish.
				</label>
			)}
			{changed && !target && <p className="sh-field-hint">Removing this session revokes new fleet access; accepted work may finish, and the transcript remains.</p>}
			{operatorChangeForbidden && <p className="sh-field-hint">A running superagent cannot enter another namespace; start a fresh operator session.</p>}
			{error && <div className="sh-connect-error" role="alert">{error}</div>}
			{feedback && <div className="hb-session-note" role="status">{feedback}</div>}
			<button
				type="button"
				className="sh-btn"
				disabled={!changed || busy || namespaces === null || !allowed || operatorChangeForbidden || (Boolean(target) && !acknowledged)}
				onClick={() => void move()}
			>
				{busy ? "updating…" : target ? "Apply namespace" : "Remove from namespace"}
			</button>
		</section>
	);
}
