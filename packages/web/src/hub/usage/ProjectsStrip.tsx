/**
 * Second-order answers, kept at the bottom: top projects by cost (the
 * dashboard's per-folder aggregates) beside top sessions by cost (session
 * summaries, children folded in). Bars, five rows, no chrome — the fold
 * must stay cheap.
 */
import type { ReactNode } from "react";
import type { UsageFolderStats, UsageSessionSummary } from "../api";
import { fmtCost, fmtTokens, relTime, shortenPath } from "../../lib/format";

const TOP = 5;

export function ProjectsStrip({
	folders,
	sessions,
}: {
	folders: readonly UsageFolderStats[];
	sessions: readonly UsageSessionSummary[] | null;
}): ReactNode {
	const topFolders = folders.filter(folder => folder.totalCost > 0).slice(0, TOP);
	const topSessions = (sessions ?? []).filter(session => session.costTotal > 0).slice(0, TOP);
	if (topFolders.length === 0 && topSessions.length === 0) return null;

	const maxFolder = Math.max(...topFolders.map(folder => folder.totalCost), 0.000001);

	return (
		<div className="hb-uz-projects">
			{topFolders.length > 0 && (
				<section className="hb-uz-projects-col" aria-label="spend by project">
					<h3 className="hb-uz-tail-head">spend by project</h3>
					<ul className="hb-uz-projects-list">
						{topFolders.map(folder => (
							<li key={folder.folder} className="hb-uz-projects-row">
								<span className="hb-uz-projects-name" title={folder.folder}>
									{shortenPath(folder.folder)}
								</span>
								<span className="hb-uz-sharebar" aria-hidden="true">
									<span style={{ width: `${(folder.totalCost / maxFolder) * 100}%` }} />
								</span>
								<span className="hb-uz-tail-cost">{fmtCost(folder.totalCost)}</span>
							</li>
						))}
					</ul>
				</section>
			)}
			{topSessions.length > 0 && (
				<section className="hb-uz-projects-col" aria-label="top sessions by cost">
					<h3 className="hb-uz-tail-head">top sessions</h3>
					<ul className="hb-uz-projects-list">
						{topSessions.map(session => (
							<li key={session.file} className="hb-uz-projects-row">
								<span className="hb-uz-projects-name" title={`${session.folder} — ${session.models.join(", ")}`}>
									{session.title ?? shortenPath(session.file)}
								</span>
								<span className="hb-uz-projects-meta">
									{fmtTokens(session.totalTokens)} · {relTime(session.endedAt)}
								</span>
								<span className="hb-uz-tail-cost">{fmtCost(session.costTotal)}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
