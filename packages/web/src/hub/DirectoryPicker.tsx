/**
 * Directory picker for the start-session form: browses the selected machine's
 * filesystem through the hub's machine-level `list-dir` command (protocol §2
 * "Machine commands") and reports an absolute path. Navigation only — the form's
 * text input remains editable and is the source of truth for the value.
 */
import { ArrowUp, Check, CornerDownRight, Folder, Home, LoaderCircle, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DirListing } from "./api";
import { errorText, listMachineDirectories } from "./api";
import { Modal } from "./Modal";

export interface DirectoryPickerProps {
	/** Connected machine to browse; the picker mounts only with one selected. */
	machineId: string;
	/** Path to list first; empty or missing starts at the machine home. */
	initialPath?: string;
	onClose(): void;
	/** Receives the chosen absolute path (the owner closes the dialog). */
	onSelect(path: string): void;
}

interface Crumb {
	name: string;
	path: string;
}

export function DirectoryPicker({ machineId, initialPath, onClose, onSelect }: DirectoryPickerProps): ReactNode {
	// `undefined` = the machine home; a bad path surfaces an error the user can
	// back out of via "start at home".
	const [cursor, setCursor] = useState<string | undefined>(initialPath);
	const [listing, setListing] = useState<DirListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// Bumping re-runs the listing for the same cursor (retry, refresh).
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		listMachineDirectories(machineId, cursor)
			.then(result => {
				if (!cancelled) setListing(result);
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
	}, [machineId, cursor, attempt]);

	const enter = useCallback((dir: string) => setCursor(dir), []);

	// Clickable path segments: "/home/dev" → [home → /home, dev → /home/dev].
	const crumbs = useMemo<Crumb[]>(() => {
		if (!listing) return [];
		const parts = listing.path.split("/").filter(part => part.length > 0);
		return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join("/")}` }));
	}, [listing]);

	const body: ReactNode = (() => {
		if (!listing && loading) {
			return (
				<p className="hb-busy">
					<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> listing directories…
				</p>
			);
		}
		if (error) {
			return (
				<>
					<div className="hb-modal-error" role="alert">
						{error}
					</div>
					<div className="hb-dir-actions">
						<button type="button" className="sh-btn" onClick={() => setAttempt(a => a + 1)}>
							<RotateCw size={13} aria-hidden="true" />
							<span className="sh-btn-label">Retry</span>
						</button>
						<button type="button" className="sh-btn" onClick={() => setCursor(undefined)}>
							<Home size={13} aria-hidden="true" />
							<span className="sh-btn-label">Start at home</span>
						</button>
					</div>
				</>
			);
		}
		if (!listing) return null;
		return (
			<>
				<div className="hb-dirbar">
					<button
						type="button"
						className="sh-btn"
						onClick={() => listing.parent && enter(listing.parent)}
						disabled={listing.parent === null}
						title="parent directory"
					>
						<ArrowUp size={13} aria-hidden="true" />
					</button>
					<button type="button" className="sh-btn" onClick={() => setCursor(undefined)} title="home directory">
						<Home size={13} aria-hidden="true" />
					</button>
					<nav className="hb-dir-crumbs" aria-label="current path">
						{crumbs.map((crumb, index) => (
							<button
								key={crumb.path}
								type="button"
								className="hb-crumb"
								disabled={index === crumbs.length - 1}
								onClick={() => enter(crumb.path)}
							>
								{crumb.name}
							</button>
						))}
					</nav>
					<button
						type="button"
						className="sh-btn"
						onClick={() => setAttempt(a => a + 1)}
						disabled={loading}
						title="refresh"
					>
						<RotateCw size={13} className={loading ? "hb-spin" : undefined} aria-hidden="true" />
					</button>
				</div>
				{listing.entries.length === 0 ? (
					<p className="hb-empty">no subdirectories</p>
				) : (
					<ul className="hb-pick-list">
						{listing.entries.map(entry => (
							<li key={entry.path} className="hb-dir-row">
								<button type="button" className="hb-pick-row" onClick={() => enter(entry.path)}>
									<Folder size={13} aria-hidden="true" />
									<span className="hb-pick-name">{entry.name}</span>
								</button>
								<button
									type="button"
									className="sh-btn hb-dir-choose"
									onClick={() => onSelect(entry.path)}
									title={`use ${entry.path}`}
								>
									<CornerDownRight size={13} aria-hidden="true" />
									<span className="sh-btn-label">Use</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{listing.truncated && (
					<p className="hb-dir-note">listing capped — keep navigating or use the path field</p>
				)}
				<div className="hb-dir-actions">
					<button type="button" className="sh-btn hb-dir-confirm" onClick={() => onSelect(listing.path)}>
						<Check size={13} aria-hidden="true" />
						<span className="sh-btn-label">Use this directory</span>
					</button>
				</div>
			</>
		);
	})();

	return (
		<Modal title="Working directory" onClose={onClose}>
			{body}
		</Modal>
	);
}
