/** `read` — file/URL/internal-URI reads: typed target summary, parsed fields, highlighted content, image thumbnails. */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, PathText, ResultImages, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, languageFromPath, num, shortenPath, str } from "../util";
import { type ParsedPath, parseToolPath } from "../uri";

/** Fields of `ReadToolDetails` the web view surfaces (untrusted wire JSON). */
interface ReadDetails {
	resolvedPath: string | null;
	suffixTo: string | null;
	suffixFrom: string | null;
	elidedSpans: number | null;
	conflictCount: number | null;
	truncated: boolean;
}

function readDetails(details: Record<string, unknown> | null): ReadDetails {
	const suffix = details && isRecord(details.suffixResolution) ? details.suffixResolution : null;
	const summary = details && isRecord(details.summary) ? details.summary : null;
	return {
		resolvedPath: details ? str(details.resolvedPath) : null,
		suffixTo: suffix ? str(suffix.to) : null,
		suffixFrom: suffix ? str(suffix.from) : null,
		elidedSpans: summary ? num(summary.elidedSpans) : null,
		conflictCount: details ? num(details.conflictCount) : null,
		truncated: details ? isRecord(details.truncation) : false,
	};
}

interface ReadArgs {
	parsed: ParsedPath;
	from: number | null;
	to: number | null;
}

function readArgs(args: Record<string, unknown>): ReadArgs {
	const rawPath = str(args.path) ?? str(args.file_path) ?? "";
	const parsed = parseToolPath(rawPath);
	const offset = num(args.offset);
	const limit = num(args.limit);
	const from = offset !== null || limit !== null ? (offset ?? 1) : null;
	const to = from !== null && limit !== null ? from + limit - 1 : null;
	return { parsed, from, to };
}

function Summary(props: ToolRenderProps): ReactNode {
	const { parsed, from, to } = readArgs(props.args);
	return <PathText path={parsed.path || "…"} from={from} to={to} sel={str(props.args.sel) ?? parsed.sel} />;
}

const JOB_TONES: Record<string, "accent" | "ok" | "err" | "warn"> = {
	running: "accent",
	completed: "ok",
	ready: "ok",
	failed: "err",
	cancelled: "warn",
	exited: "warn",
};

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function jobState(job: Record<string, unknown>): string {
	return str(job.status) ?? str(job.state) ?? "?";
}

/** Structured `details.proc` payload (jobs, services, cancellations) as labeled rows. */
function ProcDetails({ details }: { details: Record<string, unknown> | null }): ReactNode {
	const proc = details && isRecord(details.proc) ? details.proc : null;
	if (!proc) return null;
	const jobs = [...(Array.isArray(proc.jobs) ? proc.jobs : []), ...(proc.job ? [proc.job] : [])];
	const daemons = [...(Array.isArray(proc.daemons) ? proc.daemons : []), ...(proc.daemon ? [proc.daemon] : [])];
	const cancelled = Array.isArray(proc.cancelled) ? proc.cancelled : [];
	const rows: ReactNode[] = [];
	for (const entry of jobs) {
		if (!isRecord(entry)) continue;
		const status = jobState(entry);
		const label = str(entry.label);
		const duration = num(entry.durationMs);
		rows.push(
			<Row key={`j${str(entry.id) ?? rows.length}`} k={<Badge tone={JOB_TONES[status]}>{status}</Badge>}>
				{str(entry.type) && <span className="tv-muted">{str(entry.type)} </span>}
				<span>{str(entry.id) ?? "?"}</span>
				{label && <span className="tv-faint"> {label}</span>}
				{duration !== null && duration > 0 && <span className="tv-faint"> · {fmtDuration(duration)}</span>}
			</Row>,
		);
	}
	for (const entry of daemons) {
		if (!isRecord(entry)) continue;
		const state = jobState(entry);
		const mode = entry.persist === true ? "persist" : entry.detached === true ? "detached" : entry.mode === "persist" || entry.mode === "session" || entry.mode === "detached" ? str(entry.mode) : null;
		const restarts = num(entry.restartCount);
		rows.push(
			<Row key={`d${str(entry.id) ?? rows.length}`} k={<Badge tone={JOB_TONES[state]}>{state}</Badge>}>
				<span className="tv-muted">service </span>
				<span>{str(entry.id) ?? str(entry.name) ?? "?"}</span>
				{mode && <Badge>{mode}</Badge>}
				{restarts !== null && restarts > 0 && <span className="tv-faint"> · {restarts} restarts</span>}
			</Row>,
		);
	}
	for (const entry of cancelled) {
		if (!isRecord(entry)) continue;
		rows.push(
			<Row key={`c${str(entry.id) ?? rows.length}`} k={<Badge tone="warn">{str(entry.status) ?? "cancelled"}</Badge>}>
				{str(entry.id) ?? "?"}
			</Row>,
		);
	}
	if (rows.length === 0) return null;
	return <div className="tv-list">{rows}</div>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const { parsed } = readArgs(args);
	const d = readDetails(detailsRecord(result));
	const conflictBadge = d.conflictCount !== null && d.conflictCount > 0 && (
		<Badge tone="warn">
			{d.conflictCount} conflict{d.conflictCount === 1 ? "" : "s"}
		</Badge>
	);
	const elidedBadge = d.elidedSpans !== null && d.elidedSpans > 0 && (
		<Badge>
			{d.elidedSpans} elided span{d.elidedSpans === 1 ? "" : "s"}
		</Badge>
	);
	const truncatedBadge = d.truncated && <Badge tone="warn">truncated</Badge>;
	const resolved = d.suffixTo ?? d.resolvedPath;
	const rawPath = str(args.path) ?? str(args.file_path) ?? "";
	// `resolvedPath` mirrors the URI itself for internal schemes — only useful when it adds info.
	const resolvedUseful = resolved !== null && resolved !== rawPath && resolved !== parsed.raw;
	return (
		<>
			{parsed.fields.length > 0 && (
				<KvGrid>
					{parsed.fields.map(([k, v]) => (
						<Kv key={k} k={k}>
							{v}
						</Kv>
					))}
				</KvGrid>
			)}
			{(resolvedUseful || d.suffixFrom !== null) && (
				<KvGrid>
					{resolvedUseful && (
						<Kv k="resolved">
							<PathText path={resolved} />
						</Kv>
					)}
					{d.suffixFrom !== null && <Kv k="corrected from">{shortenPath(d.suffixFrom)}</Kv>}
				</KvGrid>
			)}
			<Badges items={[conflictBadge, elidedBadge, truncatedBadge]} />
			<ProcDetails details={detailsRecord(result)} />
			<ResultImages result={result} />
			<ResultText result={result} maxLines={12} lang={languageFromPath(parsed.path)} variant="code" />
		</>
	);
}

export const readRenderer: ToolRenderer = { Summary, Body };
