/**
 * Late LSP diagnostics card for `lsp-late-diagnostic` custom messages: the
 * SDK attaches structured `details.files` (per-file summary + messages) for
 * exactly this type and the TUI renders it as a dedicated disclosure card —
 * the message's text body is a model-facing `<system-notice>` wrapper and is
 * never shown. Older hosts without structured details fall back to the
 * stripped notice text.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { languageFromPath } from "../../tool-render/util";
import type { CustomMessageEntry, LateDiagnosticsFile } from "../../lib/wire";
import { stripSystemNotice } from "../../lib/system-notice";

/** Tolerant read of `CustomMessageEntry.details`; null when unusable or empty. */
export function lateDiagnosticsFiles(details: unknown): LateDiagnosticsFile[] | null {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
	const files = (details as { files?: unknown }).files;
	if (!Array.isArray(files)) return null;
	const parsed: LateDiagnosticsFile[] = [];
	for (const file of files) {
		if (typeof file !== "object" || file === null) continue;
		const record = file as Record<string, unknown>;
		parsed.push({
			path: typeof record.path === "string" ? record.path : undefined,
			summary: typeof record.summary === "string" ? record.summary : undefined,
			errored: record.errored === true,
			messages: Array.isArray(record.messages)
				? record.messages.filter((message): message is string => typeof message === "string")
				: [],
		});
	}
	return parsed.length > 0 ? parsed : null;
}

/** One expanded file block: language-tagged path, summary, diagnostic lines. */
function DiagnosticsFileRow({ file }: { file: LateDiagnosticsFile }): ReactNode {
	const messages = file.messages ?? [];
	return (
		<div className="tr-diag-file">
			<div className="tr-diag-path">
				{file.path && <span className="tr-diag-lang">{languageFromPath(file.path) ?? "text"}</span>}
				<span className="tr-diag-file-name">{file.path ?? "(unknown file)"}</span>
				{file.errored === true && (
					<span className="tr-diag-err" aria-label="errors present">
						●
					</span>
				)}
			</div>
			{file.summary && <div className="tr-diag-summary">{file.summary}</div>}
			{messages.length > 0 && (
				<ul className="tr-diag-messages">
					{messages.map((message, index) => (
						<li key={index}>{message}</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Disclosure card for one `lsp-late-diagnostic` entry. */
export function LateDiagnostics({ entry }: { entry: CustomMessageEntry }): ReactNode {
	const [open, setOpen] = useState(false);
	const files = lateDiagnosticsFiles(entry.details);
	const errored = files?.some(file => file.errored === true) ?? false;
	const messageCount = files?.reduce((sum, file) => sum + (file.messages?.length ?? 0), 0) ?? 0;

	const head = (
		<button type="button" className="tr-diag-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
			<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden="true" />
			late diagnostics
			{files && (
				<span className="tr-diag-meta">
					· {files.length} file{files.length === 1 ? "" : "s"}
					{messageCount > 0 && ` · ${messageCount} message${messageCount === 1 ? "" : "s"}`}
				</span>
			)}
			{errored && (
				<span className="tr-diag-err" aria-label="errors present">
					●
				</span>
			)}
		</button>
	);

	if (!files) {
		// No structured payload (older hosts): show the stripped notice text.
		const text = typeof entry.content === "string" ? stripSystemNotice(entry.content) : "";
		return (
			<div className="tr-diag">
				{head}
				{open && <div className="tr-diag-body">{text !== "" && <div className="tr-text">{text}</div>}</div>}
			</div>
		);
	}

	return (
		<div className="tr-diag">
			{head}
			{open && (
				<div className="tr-diag-body">
					{files.map((file, index) => (
						<DiagnosticsFileRow key={file.path ?? index} file={file} />
					))}
				</div>
			)}
		</div>
	);
}
