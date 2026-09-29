import { Square } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { errorText, stopSession, type SessionRecord } from "./api";
import { LinksSection } from "./LinksModal";
import { Modal } from "./Modal";
import { sessionsStore } from "./sessions-store";
import { pushToast } from "./toasts";

/** Stop preserves the hub record; delete in the rail remains a separate action. */
export function SessionActionsModal({ record, onClose }: { record: SessionRecord; onClose(): void }): ReactNode {
	const [stopping, setStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canStop = record.status === "live" || record.status === "starting";

	const stop = (): void => {
		if (stopping || !canStop) return;
		setStopping(true);
		setError(null);
		void stopSession(record.id).then(
			() => {
				sessionsStore.refresh();
				pushToast("info", `stop requested for ${record.name}`);
				onClose();
			},
			(err: unknown) => {
				setStopping(false);
				setError(errorText(err));
			},
		);
	};

	return (
		<Modal title={`Manage ${record.name}`} onClose={onClose}>
			{canStop && (
				<div className="hb-session-manage-stop">
					<button type="button" className="sh-btn sh-btn-stop" onClick={stop} disabled={stopping}>
						<Square size={12} aria-hidden="true" />
						{stopping ? "stopping…" : "Stop session"}
					</button>
					<p className="hb-card-note">Stops the agent but keeps this session in the hub list for restart.</p>
				</div>
			)}
			{error && <div className="sh-connect-error" role="alert">{error}</div>}
			<LinksSection record={record} />
			<p className="hb-card-note">Anyone with an attach link can prompt this session; the view link is read-only.</p>
		</Modal>
	);
}
