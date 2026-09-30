/**
 * The tab's opening triage line: one verdict + the facts behind it. Color is
 * state only (ok/info/warn/err); the strip never draws chart hues.
 */
import type { ReactNode } from "react";
import type { HealthChip, Tone } from "./insights";

const TONE_CLASS: Record<Tone, string> = {
	ok: "hb-uz-tone-ok",
	info: "hb-uz-tone-info",
	warn: "hb-uz-tone-warn",
	err: "hb-uz-tone-err",
};

export function HealthStrip({ verdict, chips, busy }: { verdict: { tone: Tone; text: string }; chips: readonly HealthChip[]; busy?: boolean }): ReactNode {
	return (
		<div className={`hb-uz-health${busy ? " hb-uz-busy" : ""}`} role="status">
			<span className={`hb-uz-health-verdict ${TONE_CLASS[verdict.tone]}`}>
				<span className={`hb-dot hb-dot-${verdict.tone === "err" ? "exited" : verdict.tone === "warn" ? "warn" : "live"}`} aria-hidden="true" />
				{verdict.text}
			</span>
			<span className="hb-uz-health-chips">
				{chips.map(chip => (
					<span key={chip.label} className={`hb-uz-chip ${TONE_CLASS[chip.tone]}`} title={chip.detail}>
						<span className={`hb-uz-chip-dot ${TONE_CLASS[chip.tone]}`} aria-hidden="true" />
						{chip.label}
					</span>
				))}
			</span>
		</div>
	);
}
