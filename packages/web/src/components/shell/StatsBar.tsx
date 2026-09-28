/**
 * Customizable session-stats strip under the header — the collab-web take on
 * omp's TUI status-line usage segments (tokens, cost, ttft, cache hit/miss,
 * context, …). Metrics fold client-side from the transcript (`sessionStats`);
 * which chips render is a per-browser checkbox set (`stats-prefs`, persisted
 * in localStorage). A metric the host never reported hides instead of showing
 * a dead chip, mirroring how TUI segments hide when empty.
 */
import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtDuration, fmtPercent, fmtTokens } from "../../lib/format";
import type { SessionStats } from "../../lib/session-stats";
import { sessionStats } from "../../lib/session-stats";
import { STATS_METRICS, toggleStatsMetric, useStatsPrefs } from "../../lib/stats-prefs";
import type { StatsMetricId } from "../../lib/stats-prefs";
import { fmtUsageCost } from "../../lib/usage";

/** One chip's text + hover detail; `null` content = host never reported → hidden. */
function chipFor(
	id: StatsMetricId,
	snapshot: GuestSnapshot,
	stats: SessionStats,
): { text: string; title: string; warn?: boolean } | null {
	switch (id) {
		case "tokens":
			return {
				text: `${fmtTokens(stats.totalTokens)} tok`,
				title: "cumulative tokens · input + output + cache write; cache reads excluded (TUI parity) — they re-read the whole context every turn",
			};
		case "cost":
			return {
				text: `≈${fmtUsageCost(stats.cost)}`,
				title: "estimated session spend — provider price tables applied to reported tokens",
			};
		case "ttft": {
			if (stats.ttftLastMs === null) return null;
			const avg = stats.ttftAvgMs === null ? "" : ` · avg ${fmtDuration(stats.ttftAvgMs)}`;
			return { text: `ttft ${fmtDuration(stats.ttftLastMs)}`, title: `time to first token, latest request${avg}` };
		}
		case "cache": {
			if (stats.lastCacheMiss) {
				return {
					text: "cache miss",
					title: "the latest request read zero cached tokens after the cache had been warm — the prompt or TTL changed and every token re-priced as input",
					warn: true,
				};
			}
			if (stats.cacheHitRate === null) return null;
			return {
				text: `hit ${fmtPercent(stats.cacheHitRate)}`,
				title: `cache hit rate — cached reads over all prompt tokens (read ${fmtTokens(stats.cacheReadTokens)} / write ${fmtTokens(stats.cacheWriteTokens)} / uncached ${fmtTokens(stats.inputTokens)})`,
			};
		}
		case "ctx": {
			const usage = snapshot.state?.contextUsage;
			if (!usage || usage.tokens === null || usage.contextWindow === null || usage.contextWindow <= 0) return null;
			return {
				text: `ctx ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`,
				title: "context window usage — the header gauge shows the percent; click it for the breakdown",
			};
		}
		case "inout":
			return {
				text: `in ${fmtTokens(stats.inputTokens)} · out ${fmtTokens(stats.outputTokens)}`,
				title: "uncached prompt vs generated tokens",
			};
		case "rate":
			if (stats.tokensPerSec === null) return null;
			return {
				text: `${stats.tokensPerSec.toFixed(1)} tok/s`,
				title: "average output rate — generated tokens over whole request windows",
			};
		case "reqs":
			return { text: `${stats.requests} req`, title: "model requests so far (usage-bearing assistant messages)" };
		case "elapsed":
			return {
				text: fmtDuration(stats.requestMs),
				title: "total model request time — wall time the agent spent generating, excluding idle between turns",
			};
	}
}

export function StatsBar({ snapshot }: { snapshot: GuestSnapshot }): ReactNode {
	const visible = useStatsPrefs();
	const [open, setOpen] = useState(false);
	const stats = useMemo(() => sessionStats(snapshot.entries, snapshot.stream), [snapshot.entries, snapshot.stream]);

	// `.sh-app` reserves this strip a grid row, so even a hidden bar renders its
	// (zero-footprint) container — otherwise `main` would shift into the auto row.
	const empty = <div className="sh-stats sh-stats--empty" aria-hidden="true" />;
	// Nothing measured yet, or the user unchecked everything: render no strip.
	if (stats === null || visible.size === 0) return empty;
	const chips: ReactNode[] = [];
	for (const metric of STATS_METRICS) {
		if (!visible.has(metric.id)) continue;
		const chip = chipFor(metric.id, snapshot, stats);
		if (chip === null) continue;
		chips.push(
			<span
				key={metric.id}
				className={chip.warn ? "sh-stats-chip sh-stats-chip--warn" : "sh-stats-chip"}
				title={chip.title}
			>
				{chip.text}
			</span>,
		);
	}
	if (chips.length === 0) return empty;

	return (
		<div className="sh-stats" role="status" aria-label="session usage statistics">
			<div className="sh-stats-chips">{chips}</div>
			<button
				type="button"
				className="sh-stats-gear"
				aria-expanded={open}
				aria-label="configure stats bar"
				title="choose which metrics to show"
				onClick={() => setOpen(value => !value)}
			>
				<Settings2 size={12} aria-hidden="true" />
			</button>
			{open && (
				<>
					<div className="sh-stats-backdrop" onClick={() => setOpen(false)} />
					<div className="sh-stats-menu" role="dialog" aria-label="stats bar metrics">
						{STATS_METRICS.map(metric => (
							<label className="sh-stats-menu-row" key={metric.id}>
								<input
									type="checkbox"
									checked={visible.has(metric.id)}
									onChange={() => toggleStatsMetric(metric.id)}
								/>
								<span className="sh-stats-menu-label">{metric.label}</span>
								<span className="sh-stats-menu-desc">{metric.description}</span>
							</label>
						))}
					</div>
				</>
			)}
		</div>
	);
}
