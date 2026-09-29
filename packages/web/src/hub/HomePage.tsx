/**
 * Hub home: machines, start-session form, session list.
 *
 * Machines use a 2 s poll; sessions share the authenticated shell's registry
 * store with alerts and the rail. Poll errors retain the last good rows.
 */
import { Activity, ChevronDown, Copy, FolderClock, FolderOpen, History, LogOut, Play, RefreshCw, Settings2, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeToggle } from "../components/shell/ThemeToggle";
import { relTime } from "../lib/format";
import { sessionsStore, useSessions } from "./sessions-store";
import type { MachineRecord, MachineSession, NamespaceRecord, SessionRecord, SessionStatus } from "./api";
import { TOOL_CATALOG } from "./tool-catalog";
import {
	createNamespace,
	errorText,
	getMachineSessions,
	getMachines,
	getNamespaces,
	HubApiError,
	listMachineProfiles,
	restartDaemon,
	setSessionNamespace,
	startSession,
	stopSession,
} from "./api";
import { copyText } from "./clipboard";
import { DirectoryPicker } from "./DirectoryPicker";
import { historyStatus } from "./history-status";
import { groupSearchPaths, mergeMessageMatches, useMessageMatches } from "./message-search";
import { navigate } from "./router";
import { Modal } from "./Modal";

const POLL_MS = 2000;
const EMPTY_SESSIONS: readonly SessionRecord[] = [];

const STATUS_LABEL: Record<SessionStatus, string> = {
	starting: "starting",
	live: "live",
	exited: "exited",
	failed: "failed",
};

/** Machine-reported temp directory (`hello.tmpdir`); `/tmp` covers POSIX machines and pre-0.3.0 agents. */
const tempDirFor = (machine: MachineRecord | undefined): string => machine?.tmpdir ?? "/tmp";

export interface HomePageProps {
	onLogout(): void;
	onOpenSettings(): void;
}

export function HomePage({ onLogout, onOpenSettings }: HomePageProps): ReactNode {
	const [machines, setMachines] = useState<MachineRecord[]>([]);
	const { sessions: polledSessions, error: sessionsError } = useSessions();
	const [movedSessions, setMovedSessions] = useState<ReadonlyMap<string, SessionRecord>>(() => new Map());
	const sessions = useMemo(() => polledSessions?.map(row => {
		const moved = movedSessions.get(row.id);
		return moved && moved.membershipVersion > row.membershipVersion
			? { ...row, namespaceId: moved.namespaceId, membershipVersion: moved.membershipVersion, controllerId: moved.controllerId }
			: row;
	}) ?? EMPTY_SESSIONS, [polledSessions, movedSessions]);
	const [namespaces, setNamespaces] = useState<NamespaceRecord[]>([]);
	const [namespaceName, setNamespaceName] = useState("");
	const [namespaceBusy, setNamespaceBusy] = useState(false);
	const [namespaceError, setNamespaceError] = useState<string | null>(null);
	const [namespaceFeedback, setNamespaceFeedback] = useState<string | null>(null);
	const [namespaceId, setNamespaceId] = useState("");
	const [movingId, setMovingId] = useState<string | null>(null);
	const [moveError, setMoveError] = useState<{ id: string; message: string } | null>(null);
	const [moveFeedback, setMoveFeedback] = useState<{ id: string; message: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [namespacePollError, setNamespacePollError] = useState<string | null>(null);
	const [machineId, setMachineId] = useState("");
	/** Machine awaiting restart confirmation; null renders no dialog. */
	const [confirmRestart, setConfirmRestart] = useState<MachineRecord | null>(null);
	const [cwd, setCwd] = useState("");
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [profiles, setProfiles] = useState<string[]>([]);
	const [profile, setProfile] = useState("");
	const [superagent, setSuperagent] = useState(false);
	const [selectedTools, setSelectedTools] = useState<string[]>([]);
	const [toolsOpen, setToolsOpen] = useState(false);
	const toolsRef = useRef<HTMLDivElement | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [flash, setFlash] = useState<{ key: string; ok: boolean } | null>(null);
	const [history, setHistory] = useState<MachineSession[] | null>(null);
	const [historyTruncated, setHistoryTruncated] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [historyBusy, setHistoryBusy] = useState(false);
	const [historyFilter, setHistoryFilter] = useState("");

	useEffect(() => {
		let cancelled = false;
		const tick = async (): Promise<void> => {
			const [machinesResult, namespacesResult] = await Promise.allSettled([getMachines(), getNamespaces()]);
			if (cancelled) return;
			if (machinesResult.status === "fulfilled") {
				setMachines(machinesResult.value);
				setError(null);
			} else {
				setError(errorText(machinesResult.reason));
			}
			if (namespacesResult.status === "fulfilled") {
				setNamespaces(namespacesResult.value);
				setNamespacePollError(null);
			} else {
				setNamespacePollError(errorText(namespacesResult.reason));
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
	// A machine restriction may change on the server while the form is open.
	useEffect(() => {
		if (namespaceId && !namespaces.some(ns => ns.id === namespaceId && (ns.machineIds === null || ns.machineIds.includes(machineId)))) {
			setNamespaceId("");
		}
	}, [machineId, namespaceId, namespaces]);


	// Profiles are machine-local state: refetch on machine switches and drop a
	// stale selection. A listing failure leaves default-only, never blocks a start.
	useEffect(() => {
		let cancelled = false;
		setProfile("");
		if (!machineId) {
			setProfiles([]);
			return;
		}
		listMachineProfiles(machineId)
			.then(found => {
				if (!cancelled) setProfiles(found);
			})
			.catch(() => {
				if (!cancelled) setProfiles([]);
			});
		return () => {
			cancelled = true;
		};
	}, [machineId]);

	// History changes only when someone uses omp on the machine, so it loads on
	// machine switch and manual refresh instead of joining the 2 s poll.
	const loadHistory = useCallback(async (id: string): Promise<void> => {
		if (!id) {
			setHistory(null);
			setHistoryTruncated(false);
			setHistoryError(null);
			return;
		}
		setHistoryBusy(true);
		try {
			const listing = await getMachineSessions(id);
			setHistory(listing.sessions);
			setHistoryTruncated(listing.truncated);
			setHistoryError(null);
		} catch (err) {
			setHistoryError(errorText(err));
		} finally {
			setHistoryBusy(false);
		}
	}, []);

	useEffect(() => {
		void loadHistory(machineId);
	}, [machineId, loadHistory]);

	const metadataHistory = useMemo(() => {
		const needle = historyFilter.trim().toLowerCase();
		const all = history ?? [];
		if (!needle) return all;
		return all.filter(
			entry =>
				(entry.title ?? "").toLowerCase().includes(needle) ||
				entry.cwd.toLowerCase().includes(needle) ||
				// Absent profile means the default profile, so it stays filterable.
				(entry.profile ?? "default").toLowerCase().includes(needle) ||
				entry.firstMessage.toLowerCase().includes(needle),
		);
	}, [history, historyFilter]);

	// Message-text search over this machine's listed history: rows matching
	// only in prompt/assistant text trail the metadata matches (≥ 2 chars).
	const searchGroups = useMemo(
		() => (machineId ? groupSearchPaths(history ?? [], entry => ({ machineId, path: entry.path })) : []),
		[machineId, history],
	);
	const msgMatches = useMessageMatches(searchGroups, historyFilter);
	const filteredHistory = useMemo(
		() => mergeMessageMatches(history ?? [], entry => entry.path, metadataHistory, msgMatches),
		[history, metadataHistory, msgMatches],
	);

	/** Start a new hub session that resumes `entry`'s omp history. */
	const resume = async (entry: MachineSession): Promise<void> => {
		if (!machineId || busy) return;
		setBusy(true);
		setFormError(null);
		try {
			const session = await startSession({
				machineId,
				cwd: entry.cwd,
				name: entry.title || undefined,
				// The resumed session must run under the profile that owns it.
				profile: entry.profile,
				sessionFile: entry.path,
			});
			setBusy(false);
			navigate(`/s/${session.id}`);
		} catch (err) {
			setBusy(false);
			setFormError(errorText(err));
		}
	};
	const submitNamespace = async (): Promise<void> => {
		const trimmed = namespaceName.trim();
		if (!trimmed || namespaceBusy) {
			if (!trimmed) setNamespaceError("namespace name is required");
			return;
		}
		setNamespaceBusy(true);
		setNamespaceError(null);
		setNamespaceFeedback(null);
		try {
			const created = await createNamespace(trimmed);
			setNamespaces(previous => [...previous.filter(ns => ns.id !== created.id), created]);
			setNamespaceName("");
			setNamespaceFeedback(`Created namespace ${created.name}`);
		} catch (err) {
			setNamespaceError(errorText(err));
		} finally {
			setNamespaceBusy(false);
		}
	};

	const moveSession = async (session: SessionRecord, targetId: string | null): Promise<void> => {
		if (movingId || session.namespaceId === targetId) return;
		setMovingId(session.id);
		setMoveError(null);
		setMoveFeedback(null);
		try {
			const updated = await setSessionNamespace(session.id, targetId, session.membershipVersion);
			setMovedSessions(previous => new Map(previous).set(updated.id, updated));
			sessionsStore.refresh();
			setMoveFeedback({ id: session.id, message: targetId === null ? "Removed from namespace" : "Namespace updated" });
		} catch (err) {
			setMoveError({
				id: session.id,
				message: err instanceof HubApiError && err.status === 409
					? `Namespace assignment changed. ${errorText(err)} Refresh and retry.`
					: errorText(err),
			});
			if (err instanceof HubApiError && err.status === 409) {
				sessionsStore.refresh();
			}
		} finally {
			setMovingId(null);
		}
	};

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
		if (superagent && !namespaceId) {
			setFormError("choose a namespace for the superagent");
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
				profile: profile || undefined,
				superagent: superagent || undefined,
				namespaceId: namespaceId || undefined,
				tools: !superagent && selectedTools.length > 0 ? selectedTools : undefined,
			});
			setName("");
			setPrompt("");
			setSuperagent(false);
			setSelectedTools([]);
			setToolsOpen(false);
			setBusy(false);
			setNamespaceId("");
			navigate(`/s/${session.id}`);
		} catch (err) {
			setBusy(false);
			setFormError(errorText(err));
		}
	};

	/** Add/remove one tool from the whitelist; order follows the clicks. */
	const toggleTool = (tool: string): void => {
		setSelectedTools(prev => (prev.includes(tool) ? prev.filter(name => name !== tool) : [...prev, tool]));
	};

	// The whitelist menu closes on Esc and on any press outside the picker —
	// capture phase, so the same pattern as the hub modals.
	useEffect(() => {
		if (!toolsOpen) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (toolsRef.current && event.target instanceof Node && !toolsRef.current.contains(event.target)) {
				setToolsOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setToolsOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [toolsOpen]);

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
					<button type="button" className="sh-btn hb-settings-entry" onClick={onOpenSettings} aria-label="omp-hub settings">
						<Settings2 size={14} aria-hidden="true" />
						<span className="sh-btn-label">Settings</span>
					</button>
					<button type="button" className="sh-btn" onClick={onLogout} aria-label="Logout">
						<LogOut size={14} aria-hidden="true" />
						<span className="sh-btn-label">Logout</span>
					</button>
				</div>
			</header>

			{(error || namespacePollError || sessionsError) && (
				<div className="hb-banner" role="alert">
					{error || namespacePollError || sessionsError}
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
										{m.connected && !m.restarting && (
											<button
												type="button"
												className="sh-btn hb-machine-restart"
												onClick={() => setConfirmRestart(m)}
												title="restart the machine daemon to pick up new agent code; sessions resume from their transcripts"
											>
												<RefreshCw size={14} aria-hidden="true" />
												<span className="sh-btn-label">Restart daemon</span>
											</button>
										)}
										{m.restarting && <span className="hb-machine-note">restarting…</span>}
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
						<h2 className="hb-card-title">Fleet namespaces</h2>
						<p className="hb-card-note">Sessions in a namespace are visible to its superagents. Machine restrictions limit where they can start workers.</p>
						{namespaces.length === 0 ? (
							<p className="hb-empty">no namespaces yet</p>
						) : (
							<ul className="hb-machines">
								{namespaces.map(ns => (
									<li key={ns.id} className="hb-machine">
										<span className="hb-machine-name">{ns.name}</span>
										<span className="hb-machine-id">{ns.id}</span>
										<span className="hb-machine-count">
											{ns.machineIds === null ? "all machines" : ns.machineIds.length === 0 ? "no machines" : ns.machineIds.map(id => machines.find(m => m.machineId === id)?.name ?? id).join(", ")}
										</span>
										<span className="hb-machine-count">
											{sessions.filter(s => s.namespaceId === ns.id).length} sessions
										</span>
									</li>
								))}
							</ul>
						)}
						<form className="hb-form" onSubmit={e => { e.preventDefault(); void submitNamespace(); }}>
							<label className="sh-field">
								<span className="sh-field-label">new namespace name</span>
								<input className="sh-input" value={namespaceName} onChange={e => setNamespaceName(e.target.value)} maxLength={64} placeholder="team or project" />
							</label>
							{namespaceError && <div className="sh-connect-error" role="alert">{namespaceError}</div>}
							{namespaceFeedback && <div className="hb-session-note" role="status">{namespaceFeedback}</div>}
							<button type="submit" className="sh-btn" disabled={namespaceBusy}>{namespaceBusy ? "creating…" : "Create namespace"}</button>
						</form>
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
							<label className="sh-field">
								<span className="sh-field-label">omp profile (optional)</span>
								<select
									className="sh-input"
									value={profile}
									onChange={e => setProfile(e.target.value)}
									disabled={!machineId}
									title="named omp profile the session runs under"
								>
									<option value="">default</option>
									{profiles.map(p => (
										<option key={p} value={p}>
											{p}
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
									<button
										type="button"
										className="sh-btn"
										onClick={() => setCwd(tempDirFor(connected.find(m => m.machineId === machineId)))}
										disabled={!machineId}
										title="fill in the selected machine's temp directory"
									>
										<FolderClock size={14} aria-hidden="true" />
										<span className="sh-btn-label">Temp dir</span>
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
							<div className="sh-field" hidden={superagent}>
								<span className="sh-field-label">tools whitelist (optional)</span>
								<div className="hb-tools-picker" ref={toolsRef}>
									<div className="hb-tools-row">
										<button
											type="button"
											className="sh-input hb-tools-toggle"
											onClick={() => setToolsOpen(open => !open)}
											aria-expanded={toolsOpen}
											aria-haspopup="true"
											title={selectedTools.length > 0 ? selectedTools.join(", ") : "all tools"}
										>
											<span className="hb-tools-summary">
												{selectedTools.length === 0
													? "default — all tools"
													: `${selectedTools.length} selected`}
											</span>
											<ChevronDown size={14} aria-hidden="true" />
										</button>
										{selectedTools.length > 0 && (
											<button
												type="button"
												className="sh-btn"
												onClick={() => setSelectedTools([])}
												title="back to the default tool set"
											>
												<X size={14} aria-hidden="true" />
												<span className="sh-btn-label">clear</span>
											</button>
										)}
									</div>
									{toolsOpen && (
										<div className="hb-tools-menu" role="group" aria-label="tools whitelist">
											{TOOL_CATALOG.map(tool => (
												<label key={tool.name} className="hb-tool-option">
													<input
														type="checkbox"
														checked={selectedTools.includes(tool.name)}
														onChange={() => toggleTool(tool.name)}
													/>
													<span className="hb-tool-name" title={tool.label}>
														{tool.name}
													</span>
													<span className="hb-tool-desc">{tool.description}</span>
												</label>
											))}
										</div>
									)}
								</div>
								<span className="sh-field-hint">
									pick tools to restrict the session; none selected keeps the default set
								</span>
							</div>
							<label className="sh-field">
								<span className="sh-field-label">
									<input
										type="checkbox"
										checked={superagent}
										onChange={e => {
											setSuperagent(e.target.checked);
											if (e.target.checked) {
												setSelectedTools([]);
												setToolsOpen(false);
											}
										}}
									/>
									{" "}superagent
								</span>
								<span className="sh-field-hint">fleet-only tools scoped to the selected namespace; no direct filesystem or shell tools</span>
							</label>
							<label className="sh-field">
								<span className="sh-field-label">fleet namespace {superagent ? "(required for superagents)" : "(optional)"}</span>
								<select className="sh-input" value={namespaceId} onChange={e => setNamespaceId(e.target.value)}>
									<option value="">no namespace</option>
									{namespaces.map(ns => (
										<option key={ns.id} value={ns.id} disabled={ns.machineIds !== null && !ns.machineIds.includes(machineId)}>
											{ns.name}{ns.machineIds !== null && !ns.machineIds.includes(machineId) ? " (machine not allowed)" : ""}
										</option>
									))}
								</select>
								<span className="sh-field-hint">a superagent can manage only sessions in its namespace</span>
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
											<span className={`hb-dot hb-dot-${s.unreachable ? "unreachable" : s.status}`} aria-label={s.unreachable ? "unreachable" : STATUS_LABEL[s.status]} />
											<span className="hb-session-name" title={s.name}>
												{s.name}
											</span>
											<span className="hb-status">{s.unreachable ? "unreachable" : STATUS_LABEL[s.status]}</span>
										</div>
										<div className="hb-session-meta">
											<span className="hb-mono" title={s.cwd}>
												{s.cwd}
											</span>
											{s.profile && (
												<span className="hb-mono" title="omp profile">
													{s.profile}
												</span>
											)}
											<span className="hb-mono">{s.machineName}</span>
											<span className="hb-mono">{relTime(s.startedAt)}</span>
											<span className="hb-mono">namespace: {namespaces.find(ns => ns.id === s.namespaceId)?.name ?? s.namespaceId ?? "none"}</span>
											{s.controllerId && <span className="hb-mono" title={s.controllerId}>controller: {sessions.find(owner => owner.id === s.controllerId)?.name ?? s.controllerId}</span>}
										</div>
										{s.status === "failed" && s.error && <div className="hb-session-error">{s.error}</div>}
										{s.status === "live" && (
											<SessionNamespaceControl
												key={`${s.id}:${s.membershipVersion}`}
												session={s}
												namespaces={namespaces}
												busy={movingId === s.id}
												disabled={movingId !== null}
												error={moveError?.id === s.id ? moveError.message : null}
												feedback={moveFeedback?.id === s.id ? moveFeedback.message : null}
												onMove={targetId => void moveSession(s, targetId)}
											/>
										)}
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
													disabled={s.unreachable}
													title={s.unreachable ? "machine is offline; stop after it reconnects" : undefined}
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

					<section className="hb-card">
						<div className="hb-history-head">
							<h2 className="hb-card-title">History</h2>
							<button
								type="button"
								className="sh-btn"
								onClick={() => void loadHistory(machineId)}
								disabled={!machineId || historyBusy}
								title="reload this machine's omp session history"
							>
								<History size={14} aria-hidden="true" />
								<span className="sh-btn-label">{historyBusy ? "loading…" : "Refresh"}</span>
							</button>
						</div>
						{machineId && (
							<input
								className="sh-input hb-history-filter"
								type="text"
								value={historyFilter}
								onChange={e => setHistoryFilter(e.target.value)}
								placeholder="filter by title, directory, profile, or messages"
								spellCheck={false}
								autoComplete="off"
							/>
						)}
						{!machineId ? (
							<p className="hb-empty">no connected machine</p>
						) : historyError ? (
							<p className="hb-empty">{historyError}</p>
						) : filteredHistory.length === 0 ? (
							<p className="hb-empty">no omp sessions on this machine yet</p>
						) : (
							<ul className="hb-history">
								{filteredHistory.map(entry => {
									const status = historyStatus(entry, machineId, sessions);
									const hit = msgMatches?.[entry.path];
									return (
										<li key={entry.path} className="hb-history-item">
											<button
												type="button"
												className="hb-history-open"
												disabled={busy}
												onClick={() => void resume(entry)}
												title={`resume ${entry.path}`}
											>
												<span className="hb-history-titlerow">
													<span className="hb-history-title">
														{entry.title || entry.firstMessage || entry.id}
													</span>
													{status && (
														<span className={`hb-history-badge hb-history-badge-${status.kind}`}>
															{status.kind}
														</span>
													)}
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
												{hit !== undefined && (
													<span className="hb-history-msg" title={hit.snippet ?? ""}>
														{hit.snippet ?? `${hit.count} message matches`}
													</span>
												)}
											</button>
										</li>
									);
								})}
							</ul>
						)}
						{historyTruncated && history !== null && history.length > 0 && (
							<p className="hb-session-note">showing the {history.length} most recent sessions</p>
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
			{confirmRestart && <RestartConfirmModal machine={confirmRestart} sessions={sessions} onDone={() => setConfirmRestart(null)} />}
		</div>
	);
}

/** Explicit confirmation before exposing a live session's existing transcript to another fleet. */
function SessionNamespaceControl({ session, namespaces, busy, disabled, error, feedback, onMove }: {
	session: SessionRecord;
	namespaces: readonly NamespaceRecord[];
	busy: boolean;
	disabled: boolean;
	error: string | null;
	feedback: string | null;
	onMove(target: string | null): void;
}): ReactNode {
	const [target, setTarget] = useState(session.namespaceId ?? "");
	const [acknowledged, setAcknowledged] = useState(false);
	const changed = target !== (session.namespaceId ?? "");
	const destination = namespaces.find(ns => ns.id === target);
	const allowed = !destination || destination.machineIds === null || destination.machineIds.includes(session.machineId);
	const operatorChangeForbidden = session.superagent === true && changed && Boolean(target);
	return (
		<div className="hb-namespace-control">
			<label className="sh-field">
				<span className="sh-field-label">assign / move live session</span>
				<select
					className="sh-input"
					aria-label={`namespace for ${session.name}`}
					value={target}
					disabled={disabled}
					onChange={e => { setTarget(e.target.value); setAcknowledged(false); }}
				>
					<option value="">outside fleet (remove)</option>
					{namespaces.map(ns => (
						<option key={ns.id} value={ns.id} disabled={ns.machineIds !== null && !ns.machineIds.includes(session.machineId)}>
							{ns.name}
						</option>
					))}
				</select>
			</label>
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
			<button type="button" className="sh-btn" disabled={!changed || disabled || !allowed || operatorChangeForbidden || (Boolean(target) && !acknowledged)} onClick={() => onMove(target || null)}>
				{busy ? "updating…" : target ? "Apply namespace" : "Remove from namespace"}
			</button>
		</div>
	);
}

/** Confirmation dialog for the panel daemon restart (protocol §3): names the
 * sessions the restart bounces, warns about mid-turn runs, and surfaces the
 * API refusal (409 already restarting, 502 offline) inline. */
function RestartConfirmModal(props: {
	machine: MachineRecord;
	sessions: readonly SessionRecord[];
	onDone(): void;
}): ReactNode {
	const { machine, sessions, onDone } = props;
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const mine = sessions.filter(s => s.machineId === machine.machineId && (s.status === "live" || s.status === "starting"));
	const working = mine.filter(s => s.activity?.working);
	const submit = (): void => {
		setBusy(true);
		setFailure(null);
		restartDaemon(machine.machineId)
			.then(onDone)
			.catch(err => {
				setBusy(false);
				setFailure(errorText(err));
			});
	};
	return (
		<Modal title={`Restart daemon “${machine.name}”?`} onClose={onDone}>
			<p className="hb-restart-note">
				The machine's daemon process stops and starts again from disk to pick up new agent code.
				Its {mine.length} session{mine.length === 1 ? "" : "s"} stop and then resume automatically
				from their transcripts, keeping the same session ids.
			</p>
			{working.length > 0 && (
				<p className="hb-restart-warning" role="alert">
					{working.length} session{working.length === 1 ? " is" : "s are"} mid-turn — the current
					run aborts. The transcript stays resumable up to the abort.
				</p>
			)}
			{failure && (
				<div className="sh-connect-error" role="alert">
					{failure}
				</div>
			)}
			<div className="hb-restart-actions">
				<button type="button" className="sh-btn" onClick={onDone} disabled={busy}>
					Cancel
				</button>
				<button type="button" className="sh-btn sh-btn-primary" onClick={submit} disabled={busy}>
					<RefreshCw size={14} aria-hidden="true" />
					{busy ? "restarting…" : "Restart daemon"}
				</button>
			</div>
		</Modal>
	);
}
