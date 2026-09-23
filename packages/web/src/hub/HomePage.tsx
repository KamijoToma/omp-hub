/**
 * Hub home: machines, start-session form, session list.
 *
 * Machines and sessions are polled every 2 s while the page is mounted (the hub
 * keeps no push channel for the registry); a poll failure is surfaced in a
 * banner but never clears the last good rows.
 */
import { Activity, Copy, FolderOpen, LogOut, Play, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThemeToggle } from "../components/shell/ThemeToggle";
import { relTime } from "../lib/format";
import type { MachineRecord, SessionRecord, SessionStatus } from "./api";
import { errorText, getMachines, getSessions, startSession, stopSession } from "./api";
import { copyText } from "./clipboard";
import { DirectoryPicker } from "./DirectoryPicker";
import { navigate } from "./router";

const POLL_MS = 2000;

const STATUS_LABEL: Record<SessionStatus, string> = {
	starting: "starting",
	live: "live",
	exited: "exited",
	failed: "failed",
};

export interface HomePageProps {
	onLogout(): void;
}

export function HomePage({ onLogout }: HomePageProps): ReactNode {
	const [machines, setMachines] = useState<MachineRecord[]>([]);
	const [sessions, setSessions] = useState<SessionRecord[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [machineId, setMachineId] = useState("");
	const [cwd, setCwd] = useState("");
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [flash, setFlash] = useState<{ key: string; ok: boolean } | null>(null);

	useEffect(() => {
		let cancelled = false;
		const tick = async (): Promise<void> => {
			try {
				const [nextMachines, nextSessions] = await Promise.all([getMachines(), getSessions()]);
				if (cancelled) return;
				setMachines(nextMachines);
				setSessions(nextSessions);
				setError(null);
			} catch (err) {
				if (!cancelled) setError(errorText(err));
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	// Copy feedback reverts on its own; a new copy restarts the countdown.
	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(null), 1600);
		return () => clearTimeout(timer);
	}, [flash]);

	const connected = useMemo(() => machines.filter(m => m.connected), [machines]);
	// Keep the form pinned to a machine that can actually accept a start.
	useEffect(() => {
		if (!connected.some(m => m.machineId === machineId)) setMachineId(connected[0]?.machineId ?? "");
	}, [connected, machineId]);

	const submit = async (): Promise<void> => {
		if (!machineId) {
			setFormError("no connected machine to start on");
			return;
		}
		const target = cwd.trim();
		if (!target) {
			setFormError("working directory is required");
			return;
		}
		setBusy(true);
		setFormError(null);
		try {
			const session = await startSession({
				machineId,
				cwd: target,
				name: name.trim() || undefined,
				prompt: prompt.trim() || undefined,
			});
			setName("");
			setPrompt("");
			setBusy(false);
			navigate(`/s/${session.id}`);
		} catch (err) {
			setBusy(false);
			setFormError(errorText(err));
		}
	};

	const copy = useCallback(async (key: string, text: string): Promise<void> => {
		setFlash({ key, ok: await copyText(text) });
	}, []);

	const copyLabel = (key: string, label: string): string => {
		if (flash?.key !== key) return label;
		return flash.ok ? "copied" : "copy failed";
	};

	return (
		<div className="hb-page">
			<header className="hb-top">
				<div className="sh-lockup">
					<span className="sh-lockup-mark" aria-hidden="true" />
					<span className="sh-lockup-pi">π</span> omp hub
				</div>
				<div className="hb-top-actions">
					<ThemeToggle />
					<button type="button" className="sh-btn" onClick={onLogout}>
						<LogOut size={14} aria-hidden="true" />
						<span className="sh-btn-label">Logout</span>
					</button>
				</div>
			</header>

			{error && (
				<div className="hb-banner" role="alert">
					{error}
				</div>
			)}

			<div className="hb-grid">
				<div className="hb-col">
					<section className="hb-card">
						<h2 className="hb-card-title">Machines</h2>
						{machines.length === 0 ? (
							<p className="hb-empty">no agent connected yet</p>
						) : (
							<ul className="hb-machines">
								{machines.map(m => (
									<li key={m.machineId} className="hb-machine">
										<span
											className={`hb-dot hb-dot-${m.connected ? "live" : "exited"}`}
											aria-label={m.connected ? "connected" : "offline"}
										/>
										<span className="hb-machine-name">{m.name}</span>
										<span className="hb-machine-count">{m.sessionCount} running</span>
										<span className="hb-machine-id">{m.machineId}</span>
										{m.connected && (
											<button
												type="button"
												className="sh-btn hb-machine-usage"
												onClick={() => navigate(`/usage/${m.machineId}`)}
												aria-label={`usage for ${m.name}`}
											>
												<Activity size={14} aria-hidden="true" />
												Usage
											</button>
										)}
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="hb-card">
						<h2 className="hb-card-title">Start session</h2>
						<form
							className="hb-form"
							onSubmit={e => {
								e.preventDefault();
								void submit();
							}}
						>
							<label className="sh-field">
								<span className="sh-field-label">machine</span>
								<select
									className="sh-input"
									value={machineId}
									onChange={e => setMachineId(e.target.value)}
									disabled={connected.length === 0}
								>
									{connected.length === 0 && <option value="">no connected machine</option>}
									{connected.map(m => (
										<option key={m.machineId} value={m.machineId}>
											{m.name}
										</option>
									))}
								</select>
							</label>
							<div className="sh-field">
								<span className="sh-field-label">working directory</span>
								<div className="hb-cwd-row">
									<input
										className="sh-input sh-input-mono"
										type="text"
										value={cwd}
										onChange={e => setCwd(e.target.value)}
										placeholder="/home/me/project"
										spellCheck={false}
										autoComplete="off"
									/>
									<button
										type="button"
										className="sh-btn"
										onClick={() => setPickerOpen(true)}
										disabled={!machineId}
										title="browse directories on the selected machine"
									>
										<FolderOpen size={14} aria-hidden="true" />
										<span className="sh-btn-label">Browse</span>
									</button>
								</div>
							</div>
							<label className="sh-field">
								<span className="sh-field-label">name (optional)</span>
								<input
									className="sh-input"
									type="text"
									value={name}
									onChange={e => setName(e.target.value)}
									placeholder="defaults to the directory name"
									spellCheck={false}
									autoComplete="off"
									maxLength={64}
								/>
							</label>
							<label className="sh-field">
								<span className="sh-field-label">initial prompt (optional)</span>
								<textarea
									className="sh-input hb-textarea"
									value={prompt}
									onChange={e => setPrompt(e.target.value)}
									placeholder="what should the agent do first?"
									rows={3}
									spellCheck={false}
								/>
							</label>
							{formError && (
								<div className="sh-connect-error" role="alert">
									{formError}
								</div>
							)}
							<button type="submit" className="sh-btn sh-btn-primary hb-submit" disabled={busy || !machineId}>
								<Play size={14} aria-hidden="true" />
								{busy ? "starting…" : "Start session"}
							</button>
						</form>
					</section>
				</div>

				<div className="hb-col">
					<section className="hb-card">
						<h2 className="hb-card-title">Sessions</h2>
						{sessions.length === 0 ? (
							<p className="hb-empty">no sessions yet</p>
						) : (
							<ul className="hb-sessions">
								{sessions.map(s => (
									<li key={s.id} className="hb-session">
										<div className="hb-session-head">
											<span className={`hb-dot hb-dot-${s.status}`} aria-label={STATUS_LABEL[s.status]} />
											<span className="hb-session-name" title={s.name}>
												{s.name}
											</span>
											<span className="hb-status">{STATUS_LABEL[s.status]}</span>
										</div>
										<div className="hb-session-meta">
											<span className="hb-mono" title={s.cwd}>
												{s.cwd}
											</span>
											<span className="hb-mono">{s.machineName}</span>
											<span className="hb-mono">{relTime(s.startedAt)}</span>
										</div>
										{s.status === "failed" && s.error && <div className="hb-session-error">{s.error}</div>}
										{s.status === "exited" && s.exitReason && <div className="hb-session-note">{s.exitReason}</div>}
										<div className="hb-session-actions">
											{s.status === "live" && (
												<button type="button" className="sh-btn" onClick={() => navigate(`/s/${s.id}`)}>
													Open
												</button>
											)}
											{(s.status === "live" || s.status === "starting") && (
												<button
													type="button"
													className="sh-btn sh-btn-stop"
													onClick={() => {
														void stopSession(s.id).catch(err => setError(errorText(err)));
													}}
												>
													<Square size={12} aria-hidden="true" />
													Stop
												</button>
											)}
											<button
												type="button"
												className="sh-btn"
												disabled={!s.links}
												onClick={() => {
													const link = s.links?.full;
													if (link) void copy(`${s.id}:full`, link);
												}}
											>
												<Copy size={12} aria-hidden="true" />
												{copyLabel(`${s.id}:full`, "attach link")}
											</button>
											<button
												type="button"
												className="sh-btn"
												disabled={!s.links}
												onClick={() => {
													const link = s.links?.view;
													if (link) void copy(`${s.id}:view`, link);
												}}
											>
												<Copy size={12} aria-hidden="true" />
												{copyLabel(`${s.id}:view`, "view link")}
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			</div>
			{pickerOpen && machineId && (
				<DirectoryPicker
					machineId={machineId}
					initialPath={cwd.trim() || undefined}
					onClose={() => setPickerOpen(false)}
					onSelect={path => {
						setCwd(path);
						setPickerOpen(false);
					}}
				/>
			)}
		</div>
	);
}
