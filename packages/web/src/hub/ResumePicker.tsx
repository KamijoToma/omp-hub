/**
 * Session picker behind the bare `/resume` command: lists the machine's
 * resumable omp sessions (protocol §2 machine sessions, the same listing the
 * hub home's History section renders) and hands the chosen entry to the owner,
 * which starts the hub session and navigates to it. Filter matches the hub
 * home's history filter (title, directory, profile, first message).
 */
import { Play, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { relTime } from "../lib/format";
import type { MachineSession } from "./api";
import { errorText, getMachineSessions } from "./api";
import { Modal } from "./Modal";

export interface ResumePickerProps {
	/** Connected machine whose omp session history is listed. */
	machineId: string;
	/** Starts the hub session for the chosen entry; the owner closes the dialog. */
	onResume(entry: MachineSession): void;
	onClose(): void;
}

export function ResumePicker({ machineId, onResume, onClose }: ResumePickerProps): ReactNode {
	const [sessions, setSessions] = useState<MachineSession[] | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// Bumping re-runs the listing for the same machine (retry, refresh).
	const [attempt, setAttempt] = useState(0);
	const [filter, setFilter] = useState("");
	// Disables the resume buttons between click and owner-driven unmount.
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getMachineSessions(machineId)
			.then(listing => {
				if (cancelled) return;
				setSessions(listing.sessions);
				setTruncated(listing.truncated);
				setError(null);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(errorText(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [machineId, attempt]);

	const filtered = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const all = sessions ?? [];
		if (!needle) return all;
		return all.filter(
			entry =>
				(entry.title ?? "").toLowerCase().includes(needle) ||
				entry.cwd.toLowerCase().includes(needle) ||
				// Absent profile means the default profile, so it stays filterable.
				(entry.profile ?? "default").toLowerCase().includes(needle) ||
				entry.firstMessage.toLowerCase().includes(needle),
		);
	}, [sessions, filter]);

	const pick = useCallback(
		(entry: MachineSession): void => {
			setBusy(true);
			onResume(entry);
		},
		[onResume],
	);

	const body: ReactNode = (() => {
		if (loading && sessions === null) return <p className="hb-empty">loading…</p>;
		if (error) {
			return (
				<>
					<p className="hb-empty">{error}</p>
					<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
						<RotateCw size={14} aria-hidden="true" />
						<span className="sh-btn-label">Retry</span>
					</button>
				</>
			);
		}
		return (
			<>
				<input
					className="sh-input hb-history-filter"
					type="text"
					value={filter}
					onChange={e => setFilter(e.target.value)}
					placeholder="filter by title, directory, profile, or first message"
					spellCheck={false}
					autoComplete="off"
				/>
				{filtered.length === 0 ? (
					<p className="hb-empty">no omp sessions on this machine yet</p>
				) : (
					<ul className="hb-history">
						{filtered.map(entry => (
							<li key={entry.path} className="hb-history-item">
								<button
									type="button"
									className="hb-history-open"
									disabled={busy}
									onClick={() => pick(entry)}
									title={`resume ${entry.path}`}
								>
									<span className="hb-history-title">
										<Play size={12} aria-hidden="true" />
										{entry.title || entry.firstMessage || entry.id}
									</span>
									<span className="hb-history-meta">
										<span className="hb-mono" title={entry.cwd}>
											{entry.cwd}
										</span>
										{entry.profile && (
											<span className="hb-mono" title="omp profile">
												{entry.profile}
											</span>
										)}
										<span className="hb-mono">{relTime(Date.parse(entry.modified))}</span>
										<span className="hb-mono">{entry.messageCount} msgs</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{truncated && filtered.length > 0 && (
					<p className="hb-session-note">showing the {filtered.length} most recent sessions</p>
				)}
			</>
		);
	})();

	return (
		<Modal title="Resume session" onClose={onClose}>
			{body}
		</Modal>
	);
}
