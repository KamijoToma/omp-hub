import { LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, fmtTokens, shortenPath } from "../../lib/format";
import { contextPercent } from "../../lib/usage";
import { ThemeToggle } from "./ThemeToggle";

export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	/**
	 * Hub-only (`/s/<id>`): open the model dialog. Left unset on `/join`, where
	 * the chip stays display-only.
	 */
	onOpenModel?(): void;
	/**
	 * Hub-only (`/s/<id>`): open the context breakdown. Left unset on `/join`,
	 * where the gauge stays display-only.
	 */
	onOpenContext?(): void;
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
	onOpenModel,
	onOpenContext,
}: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";
	const usage = state?.contextUsage;
	const pct = usage ? (usage.percent ?? contextPercent(usage.tokens, usage.contextWindow)) : null;
	const gaugeClass = pct != null && pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge";
	const windowText =
		usage && usage.tokens !== null && usage.contextWindow !== null
			? `${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} · `
			: "";

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
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
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
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
				<ThemeToggle />
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
