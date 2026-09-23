/**
 * Context dialog: the session's context window and what currently occupies it.
 *
 * The numbers come from the agent SDK's own `get-context` estimate, pulled
 * through `GET /api/sessions/:id/context` **on open** (and on retry) — the
 * window moves as the session works, so nothing is cached between opens. Holds
 * the same loading / error / empty states as the other hub dialogs; 404 / 409 /
 * 502 / 504 surface as their hub `{error}` text.
 */
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { fmtPercent, fmtTokens } from "../lib/format";
import { contextPercent } from "../lib/usage";
import type { SessionContext } from "./api";
import { errorText, getSessionContext } from "./api";
import { Modal } from "./Modal";

export interface ContextModalProps {
	/** Hub-assigned session id (`/s/<id>`), key for the agent-state API. */
	sessionId: string;
	onClose(): void;
}

export function ContextModal({ sessionId, onClose }: ContextModalProps): ReactNode {
	const [context, setContext] = useState<SessionContext | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void getSessionContext(sessionId).then(
			next => {
				if (cancelled) return;
				setContext(next);
				setError(null);
				setLoading(false);
			},
			(err: unknown) => {
				if (cancelled) return;
				setError(errorText(err));
				setLoading(false);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId, attempt]);

	const retry = useCallback(() => setAttempt(n => n + 1), []);

	return (
		<Modal title="Context" onClose={onClose}>
			{loading ? (
				<p className="hb-busy">
					<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading context…
				</p>
			) : error !== null ? (
				<>
					<div className="hb-modal-error" role="alert">
						{error}
					</div>
					<button type="button" className="sh-btn hb-ctx-retry" onClick={retry}>
						Retry
					</button>
				</>
			) : context === null ? (
				<p className="hb-empty">no context reported</p>
			) : (
				<ContextBody context={context} />
			)}
		</Modal>
	);
}

function ContextBody({ context }: { context: SessionContext }): ReactNode {
	const pct = contextPercent(context.usedTokens, context.contextWindow);
	// No positive window means no model is selected: the agent has nothing to
	// estimate against, so only the unavailable state can be shown.
	if (pct === null) {
		return <p className="hb-empty">context usage unavailable — no model is selected for this session</p>;
	}
	const categories = Array.isArray(context.categories) ? context.categories : [];
	const used = context.usedTokens;
	return (
		<>
			<div className="hb-ctx-head">
				<span className="hb-ctx-pct">{fmtPercent(pct)}</span>
				<span className="hb-ctx-used" title={`${used} of ${context.contextWindow} tokens`}>
					{fmtTokens(used)} / {fmtTokens(context.contextWindow)} tokens used
				</span>
			</div>
			<span className={pct > 80 ? "sh-gauge sh-gauge-warn hb-ctx-gauge" : "sh-gauge hb-ctx-gauge"}>
				<span className="sh-gauge-track hb-ctx-track">
					<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
				</span>
			</span>
			<section className="hb-modal-section">
				<div className="hb-card-title">breakdown</div>
				{categories.length === 0 ? (
					<p className="hb-empty">the agent reported no category estimates</p>
				) : (
					<ul className="hb-ctx-cats">
						{categories.map(category => (
							<li className="hb-ctx-cat" key={category.id}>
								<span className="hb-ctx-cat-label">{category.label}</span>
								<span className="hb-ctx-cat-track">
									<span
										className="hb-ctx-cat-fill"
										style={{ width: `${used > 0 ? Math.min(100, (category.tokens / used) * 100) : 0}%` }}
									/>
								</span>
								<span className="hb-ctx-cat-tokens" title={`${category.tokens} tokens`}>
									{fmtTokens(category.tokens)}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
			<dl className="hb-ctx-foot">
				<div className="hb-ctx-foot-row">
					<dt className="hb-ctx-foot-label">free</dt>
					<dd className="hb-ctx-foot-value">{fmtTokens(context.freeTokens)}</dd>
				</div>
				<div className="hb-ctx-foot-row">
					<dt className="hb-ctx-foot-label">auto-compact buffer</dt>
					<dd className="hb-ctx-foot-value">{fmtTokens(context.autoCompactBufferTokens)}</dd>
				</div>
			</dl>
			<p className="hb-card-note">
				Token counts are the agent's own estimates: the categories are approximate, and message tokens are not split
				by role.
			</p>
		</>
	);
}
