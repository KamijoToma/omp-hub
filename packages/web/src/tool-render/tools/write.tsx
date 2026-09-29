/** `write` — file create/overwrite + internal-URI ops: typed target, op badge, content preview, write confirmation. */
import type { ReactNode } from "react";
import { Badge, Badges, CodeBlock, InvalidArg, Kv, KvGrid, Note, Output, PathText, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, languageFromPath, str } from "../util";
import { type ParsedPath, parseToolPath, procAction } from "../uri";

/** Subset of the write tool's `details` payload the web renderer surfaces. */
interface WriteDiagnostics {
	server?: string;
	messages: string[];
	summary: string | null;
	errored: boolean;
}

function diagnosticsOf(details: Record<string, unknown> | null): WriteDiagnostics | null {
	if (!details || !isRecord(details.diagnostics)) return null;
	const d = details.diagnostics;
	const messages: string[] = [];
	if (Array.isArray(d.messages)) {
		for (const m of d.messages) if (typeof m === "string") messages.push(m);
	}
	const summary = str(d.summary);
	if (messages.length === 0 && !summary) return null;
	return { server: str(d.server) ?? undefined, messages, summary, errored: d.errored === true };
}

/** Peer-message delivery receipts from `details.message`. */
function receiptsOf(details: Record<string, unknown> | null): Array<{ to: string | null; outcome: string | null; error: string | null }> {
	const message = details && isRecord(details.message) ? details.message : null;
	const receipts = message && Array.isArray(message.receipts) ? message.receipts : [];
	const out: Array<{ to: string | null; outcome: string | null; error: string | null }> = [];
	for (const r of receipts) {
		if (!isRecord(r)) continue;
		out.push({ to: str(r.to), outcome: str(r.outcome), error: str(r.error) });
	}
	return out;
}

/**
 * Write operation implied by the target: `proc://<id>/kill` cancels without
 * content, `/mode` sets a service mode, `/` sends stdin, `agent://` messages a
 * peer, `cfg://…/save` persists a setting. Everything else is a plain write.
 */
function writeOp(args: Record<string, unknown>): { parsed: ParsedPath; action: string | null; contentOptional: boolean; contentTitle: string | null } {
	const parsed = parseToolPath(str(args.path) ?? str(args.file_path) ?? "");
	const proc = procAction(parsed);
	if (proc === "cancel") return { parsed, action: "cancel", contentOptional: true, contentTitle: null };
	if (proc === "mode") return { parsed, action: "mode", contentOptional: false, contentTitle: "mode" };
	if (proc === "stdin") return { parsed, action: "stdin", contentOptional: false, contentTitle: "stdin" };
	if (parsed.kind === "agent") {
		return { parsed, action: parsed.tail.includes("broadcast") ? "broadcast" : "message", contentOptional: false, contentTitle: "message" };
	}
	if (parsed.kind === "cfg") return { parsed, action: parsed.tail.includes("save") ? "persist setting" : "set setting", contentOptional: false, contentTitle: "value" };
	return { parsed, action: null, contentOptional: false, contentTitle: null };
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const { parsed, action } = writeOp(args);
	const content = str(args.content);
	const lines = content ? content.split("\n").length : 0;
	const opBadge =
		action === "broadcast" ? (
			<Badge tone="accent">broadcast</Badge>
		) : action === "message" ? (
			<Badge tone="accent">message</Badge>
		) : action === "persist setting" ? (
			<Badge tone="warn">persist</Badge>
		) : null;
	return (
		<>
			{parsed.path === "" ? <InvalidArg what="path" /> : <PathText path={parsed.path} sel={parsed.sel} />}
			{opBadge}
			{lines > 1 && <Badge>{lines} lines</Badge>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const { parsed, action, contentOptional, contentTitle } = writeOp(args);
	const content = str(args.content);
	const details = detailsRecord(result);
	const diagnostics = diagnosticsOf(details);
	const receipts = receiptsOf(details);
	const modeValue = action === "mode" && content !== null && ["persist", "session", "detached"].includes(content) ? content : null;
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
			<Badges
				items={[
					modeValue && <Badge tone="accent">{modeValue}</Badge>,
					details?.madeExecutable === true && <Badge tone="ok">made executable</Badge>,
					diagnostics?.summary && (
						<Badge tone={diagnostics.errored ? "err" : "warn"}>
							{diagnostics.server ? `${diagnostics.server}: ` : ""}
							{diagnostics.summary}
						</Badge>
					),
				]}
			/>
			{content === null ? (
				contentOptional ? null : (
					<Note tone="err">
						<InvalidArg what="content" /> — expected string
					</Note>
				)
			) : (
				content && (
					<CodeBlock code={content} lang={languageFromPath(parsed.path)} title={contentTitle ?? undefined} maxLines={12} />
				)
			)}
			<ResultText result={result} maxLines={4} />
			{receipts.length > 0 && (
				<div className="tv-list">
					{receipts.map((r, i) => (
						<Row key={i} k={r.to ?? "?"}>
							{r.outcome && <Badge tone={r.outcome === "injected" ? "ok" : "warn"}>{r.outcome}</Badge>}
							{r.error && <span className="tv-err-text"> — {r.error}</span>}
						</Row>
					))}
				</div>
			)}
			{diagnostics && diagnostics.messages.length > 0 && (
				<Output text={diagnostics.messages.join("\n")} title="diagnostics" error={diagnostics.errored} maxLines={8} />
			)}
		</>
	);
}

export const writeRenderer: ToolRenderer = { Summary, Body };
