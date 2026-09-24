import { LoaderCircle, LogOut, PanelLeft, PanelRight } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, fmtTokens, shortenPath } from "../../lib/format";
import { activeModelRole } from "../../lib/model-role";
import { contextPercent } from "../../lib/usage";
import { isImeComposing } from "./Composer";
import { ThemeToggle } from "./ThemeToggle";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	/**
	 * Hub-only (`/s/<id>`): open the session switcher drawer. Left unset on
	 * `/join`, where there is no hub session list.
	 */
	onOpenSessions?(): void;
	/**
	 * Hub-only (`/s/<id>`): open the model dialog. Left unset on `/join`, where
	 * the chip stays display-only.
	 */
	onOpenModel?(): void;
	/**
	 * Hub-only (`/s/<id>`): open the thinking-level dialog. Left unset on
	 * `/join`, where the chip stays display-only.
	 */
	onOpenThinking?(): void;
	/**
	 * Hub-only (`/s/<id>`): open the context breakdown. Left unset on `/join`,
	 * where the gauge stays display-only.
	 */
	onOpenContext?(): void;
	/**
	 * Hub-only (`/s/<id>`): rename the session from the title bar (click, then
	 * Enter). Left unset on `/join`, where the collab wire has no rename frame.
	 */
	onRename?(name: string): void;
	/**
	 * True while the agent generates a handoff document (registry `activity`
	 * mirror, protocol §3); shows the running chip. Absent on `/join`.
	 */
	handoffRunning?: boolean;
}

/** Gauge track + percentage; shared by the read-only span and the hub button. */
function Gauge({ pct }: { pct: number }): ReactNode {
	return (
		<>
			<span className="sh-gauge-track">
				<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
			</span>
			<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
		</>
	);
}

export function HeaderBar({
	snapshot,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
	onOpenSessions,
	onOpenModel,
	onOpenThinking,
	onOpenContext,
	onRename,
	handoffRunning,
}: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const activeRole = activeModelRole(snapshot.entries, state?.model);
	const title = header?.title ?? state?.sessionName ?? "session";
	const usage = state?.contextUsage;
	const pct = usage ? (usage.percent ?? contextPercent(usage.tokens, usage.contextWindow)) : null;
	const gaugeClass = pct != null && pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge";
	const windowText =
		usage && usage.tokens !== null && usage.contextWindow !== null
			? `${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} · `
			: "";

	// Title-bar rename (hub pages): the span becomes an inline input; Enter or
	// blur commits, Esc discards. Empty drafts and no-op renames close quietly.
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (renaming) inputRef.current?.select();
	}, [renaming]);
	const startRename =
		onRename && !readOnly
			? () => {
					setDraft(title === "session" ? "" : title);
					setRenaming(true);
				}
			: undefined;
	const commitRename = (): void => {
		setRenaming(false);
		const name = draft.trim();
		if (name && name !== title) onRename?.(name);
	};

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				{renaming ? (
					<input
						ref={inputRef}
						className="sh-title-input"
						value={draft}
						maxLength={200}
						spellCheck={false}
						autoComplete="off"
						aria-label="session name"
						placeholder="session name"
						onChange={e => setDraft(e.target.value)}
						onBlur={commitRename}
						onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
							if (isImeComposing(e)) return;
							if (e.key === "Enter") commitRename();
							else if (e.key === "Escape") setRenaming(false);
						}}
					/>
				) : startRename ? (
					<button type="button" className="sh-title sh-title-btn" title={`${title} — click to rename`} onClick={startRename}>
						{title}
					</button>
				) : (
					<span className="sh-title" title={title}>
						{title}
					</span>
				)}
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				{handoffRunning && (
					<span
						className="sh-chip sh-chip-handoff"
						title="generating handoff document — the summary lands in the transcript"
					>
						<LoaderCircle size={11} className="sh-chip-handoff-icon" aria-hidden="true" />
						handoff
					</span>
				)}
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model &&
					(onOpenModel ? (
						<button
							type="button"
							className="sh-chip sh-chip-meta sh-chip-btn"
							onClick={onOpenModel}
							title={`model · ${state.model.name} — switch model`}
						>
							{state.model.name}
						</button>
					) : (
						<span className="sh-chip sh-chip-meta">{state.model.name}</span>
					))}
				{activeRole !== null && activeRole !== "default" && (
					<span className="sh-chip sh-chip-meta" title={`active model role @${activeRole}`}>
						@{activeRole}
					</span>
				)}
				{state?.thinkingLevel &&
					(onOpenThinking ? (
						<button
							type="button"
							className="sh-chip sh-chip-meta sh-chip-btn"
							onClick={onOpenThinking}
							title={`thinking · ${state.thinkingLevel} — switch level`}
						>
							{state.thinkingLevel}
						</button>
					) : (
						<span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>
					))}
				{onOpenContext ? (
					pct != null ? (
						<button
							type="button"
							className={`${gaugeClass} sh-gauge-btn`}
							onClick={onOpenContext}
							title={`context · ${windowText}${fmtPercent(pct)} — show breakdown`}
						>
							<Gauge pct={pct} />
						</button>
					) : (
						<button
							type="button"
							className="sh-chip sh-chip-btn"
							onClick={onOpenContext}
							title="context usage not reported — show breakdown"
						>
							context
						</button>
					)
				) : (
					pct != null && (
						<span className={gaugeClass} title={`context · ${windowText}${fmtPercent(pct)}`}>
							<Gauge pct={pct} />
						</span>
					)
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
			</div>
			<div className="sh-header-actions">
				<ThemeToggle />
				{onOpenSessions && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onOpenSessions}
						title="switch session (Ctrl+K)"
					>
						<PanelLeft size={14} />
					</button>
				)}
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave session">
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
