import { File as FileIcon, Image as ImageIcon, LoaderCircle, Paperclip, SendHorizontal, Square, X } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import type { ImageContent } from "../../lib/wire";
import {
	classifyFile,
	expandPasteMarkers,
	formatBytes,
	imageContentFromFile,
	isLargePaste,
	MAX_IMAGE_BYTES,
	MAX_UPLOAD_BYTES,
	pasteMarker,
	removePasteMarkers,
	sanitizeUploadName,
	wrapAttachment,
} from "./composer-attachments";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
	/**
	 * Hub-side upload for binary attachments (PDF, archives, …); resolves with the
	 * machine-absolute path the model can `read`. Absent on guest pages (`/join`),
	 * which inline text and images only.
	 */
	uploadFile?: (file: File) => Promise<UploadResult>;
}

/** Result of a successful hub upload (`POST /api/sessions/:id/files`). */
export interface UploadResult {
	path: string;
	bytes: number;
}

/**
 * Content staged behind the composer: collapsed pastes live in the buffer as
 * `[Paste #N, …]` markers, images ride the wire `images` array, uploads resolve
 * to `@/machine/path` references appended at submit time.
 */
type Staged =
	| { kind: "image"; id: number; name: string; bytes: number; content?: ImageContent; error?: string }
	| { kind: "paste"; id: number; name?: string; content: string; expansion: string }
	| { kind: "upload"; id: number; name: string; bytes: number; state: "uploading" | "ready" | "error"; path?: string; error?: string };

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * True while a keydown belongs to IME composition (e.g. confirming pinyin/kana
 * candidates). Safari fires compositionend before the commit-Enter keydown, so
 * `isComposing` is already false there — it still marks the event keyCode 229.
 */
export function isImeComposing(e: { nativeEvent: { isComposing: boolean; keyCode: number } }): boolean {
	return e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
}

/** Insert `insert` at the caret of a controlled textarea; returns the next value. */
function insertAtCursor(el: HTMLTextAreaElement, value: string, insert: string): { value: string; caret: number } {
	const start = el.selectionStart ?? value.length;
	const end = el.selectionEnd ?? start;
	return { value: `${value.slice(0, start)}${insert}${value.slice(end)}`, caret: start + insert.length };
}

/** Restore the caret after React commits the new value; refocuses for paste-driven inserts. */
function restoreCaret(el: HTMLTextAreaElement, caret: number): void {
	requestAnimationFrame(() => {
		el.focus();
		el.selectionStart = el.selectionEnd = caret;
	});
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional. Large pastes collapse
 * to `[Paste #N]` markers that expand back on submit; ask responses are text-only, so files
 * and images are not staged here.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const nextId = useRef(1);
	const pastes = useRef(new Map<number, string>());

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (isImeComposing(e)) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSubmit(expandPasteMarkers(draft, pastes.current));
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const pasted = e.clipboardData?.getData("text/plain") ?? "";
		if (pasted && isLargePaste(pasted)) {
			e.preventDefault();
			const id = nextId.current++;
			pastes.current.set(id, pasted);
			const ta = taRef.current;
			if (ta) {
				const next = insertAtCursor(ta, draft, pasteMarker(id, pasted));
				setDraft(next.value);
				restoreCaret(ta, next.caret);
			}
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(expandPasteMarkers(draft, pastes.current))}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

export function Composer({ client, snapshot, uploadFile }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [staged, setStaged] = useState<Staged[]>([]);
	const [stagingError, setStagingError] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const nextId = useRef(1);

	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working || (snapshot.state?.isStreaming ?? false);
	const queued = snapshot.state?.queuedMessageCount ?? 0;

	const settledUpload = staged.some(a => a.kind === "upload" && a.state === "uploading");
	const hasImages = staged.some(a => a.kind === "image" && a.content);
	const hasUploads = staged.some(a => a.kind === "upload" && a.state === "ready");
	const canSend = canPrompt && !settledUpload && (text.trim().length > 0 || hasImages || hasUploads);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	/** Replace one staged entry (async staging fills content/state in place). */
	const updateStaged = useCallback((id: number, patch: Partial<Staged>) => {
		setStaged(prev => prev.map(item => (item.id === id ? ({ ...item, ...patch } as Staged) : item)));
	}, []);

	/** Stage collapsed paste content; the caller inserts the returned marker at the caret. */
	const stagePaste = useCallback((content: string, name?: string, expansion?: string): string => {
		const id = nextId.current++;
		setStaged(prev => [...prev, { kind: "paste", id, name, content, expansion: expansion ?? content }]);
		return pasteMarker(id, content, name);
	}, []);

	/** Stage one picked/dropped/pasted file: image → wire content, text → inline block, else upload. */
	const stageFile = useCallback(
		(file: File): void => {
			setStagingError(null);
			const kind = classifyFile(file);
			const name = sanitizeUploadName(file.name) || "file";
			if (kind === "image") {
				if (file.size > MAX_IMAGE_BYTES) {
					setStagingError(`${name}: image exceeds ${formatBytes(MAX_IMAGE_BYTES)}`);
					return;
				}
				const id = nextId.current++;
				setStaged(prev => [...prev, { kind: "image", id, name, bytes: file.size }]);
				imageContentFromFile(file)
					.then(content => updateStaged(id, { content }))
					.catch(() => updateStaged(id, { error: "read failed" }));
				return;
			}
			if (kind === "text") {
				void file.text().then(content => {
					const ta = taRef.current;
					if (!ta) return;
					const next = insertAtCursor(ta, text, stagePaste(content, name, wrapAttachment(content)));
					setText(next.value);
					restoreCaret(ta, next.caret);
				});
				return;
			}
			if (!uploadFile) {
				setStagingError(`${name}: binary attachments need a hub session page`);
				return;
			}
			if (file.size > MAX_UPLOAD_BYTES) {
				setStagingError(`${name}: file exceeds ${formatBytes(MAX_UPLOAD_BYTES)}`);
				return;
			}
			const id = nextId.current++;
			setStaged(prev => [...prev, { kind: "upload", id, name, bytes: file.size, state: "uploading" }]);
			uploadFile(file)
				.then(({ path }) => updateStaged(id, { state: "ready", path }))
				.catch(err => updateStaged(id, { state: "error", error: err instanceof Error ? err.message : String(err) }));
		},
		[stagePaste, text, updateStaged, uploadFile],
	);

	/** Paste: files first (screenshots, copied files), then oversized text; small text stays native. */
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = Array.from(e.clipboardData?.files ?? []);
		if (files.length > 0) {
			e.preventDefault();
			for (const file of files) stageFile(file);
			return;
		}
		const pasted = e.clipboardData?.getData("text/plain") ?? "";
		if (pasted && isLargePaste(pasted)) {
			e.preventDefault();
			const ta = taRef.current;
			if (ta) {
				const next = insertAtCursor(ta, text, stagePaste(pasted));
				setText(next.value);
				restoreCaret(ta, next.caret);
			}
		}
	};

	const onDrop = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault();
		setDragOver(false);
		if (!canPrompt) return;
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length > 0) {
			for (const file of files) stageFile(file);
			return;
		}
		const dropped = e.dataTransfer?.getData("text/plain") ?? "";
		if (dropped && isLargePaste(dropped)) {
			const ta = taRef.current;
			if (ta) {
				const next = insertAtCursor(ta, text, stagePaste(dropped));
				setText(next.value);
				restoreCaret(ta, next.caret);
			}
		} else if (dropped) {
			setText(prev => `${prev}${dropped}`);
		}
	};

	const onFileInput = (e: ChangeEvent<HTMLInputElement>): void => {
		for (const file of Array.from(e.target.files ?? [])) stageFile(file);
		e.target.value = "";
	};

	/** Chip removal: pastes also strip their `[Paste #N, …]` markers from the buffer. */
	const removeStaged = (item: Staged): void => {
		setStaged(prev => prev.filter(other => other.id !== item.id));
		if (item.kind === "paste") setText(prev => removePasteMarkers(prev, item.id));
	};

	const send = useCallback((): void => {
		if (!canPrompt) return;
		const expansions = new Map<number, string>();
		for (const item of staged) {
			if (item.kind === "paste") expansions.set(item.id, item.expansion);
		}
		let body = expandPasteMarkers(text, expansions);
		const images: ImageContent[] = [];
		const refs: string[] = [];
		for (const item of staged) {
			if (item.kind === "image" && item.content) images.push(item.content);
			if (item.kind === "upload" && item.state === "ready" && item.path) refs.push(`@${item.path} (${item.name})`);
		}
		if (refs.length > 0) body = `${body ? `${body}\n\n` : ""}${refs.join("\n")}`;
		if (!body.trim() && images.length === 0) return;
		client.sendPrompt(body, images.length > 0 ? images : undefined);
		setText("");
		setStaged([]);
		setStagingError(null);
	}, [canPrompt, client, staged, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (isImeComposing(e)) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (canSend) send();
		}
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	const showAttach = canPrompt;

	return (
		<div
			className={`sh-composer${dragOver ? " sh-composer-drag" : ""}`}
			onDragOver={e => {
				e.preventDefault();
				if (showAttach) setDragOver(true);
			}}
			onDragLeave={() => setDragOver(false)}
			onDrop={onDrop}
		>
			{staged.length > 0 && (
				<div className="sh-composer-chips">
					{staged.map(item => {
						const errored = (item.kind === "upload" && item.state === "error") || (item.kind === "image" && item.error);
						return (
							<span
								key={item.id}
								className={`sh-atchip sh-atchip-${item.kind}${"state" in item ? ` sh-atchip-${item.state}` : ""}${errored ? " sh-atchip-error" : ""}`}
							>
							{item.kind === "image" ? (
								<ImageIcon size={11} />
							) : item.kind === "upload" ? (
								item.state === "uploading" ? (
									<LoaderCircle size={11} className="sh-atchip-spin" />
								) : (
									<FileIcon size={11} />
								)
							) : (
								<Paperclip size={11} />
							)}
							<span className="sh-atchip-label">
								{item.kind === "paste"
									? item.name
										? `${item.name} · paste #${item.id}`
										: `paste #${item.id}`
									: item.kind === "upload"
										? item.state === "ready"
											? item.name
											: item.state === "error"
												? `${item.name}: ${item.error ?? "upload failed"}`
												: `${item.name} · uploading`
										: item.error
											? `${item.name}: ${item.error}`
											: `${item.name} · ${formatBytes(item.bytes)}`}
							</span>
							<button type="button" className="sh-atchip-remove" onClick={() => removeStaged(item)} title="remove attachment">
								<X size={10} />
							</button>
						</span>
						);
					})}
				</div>
			)}
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					placeholder={
						readOnly
							? "read-only session — watching only"
							: live
								? "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{stagingError && <span className="sh-staging-error">{stagingError}</span>}
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					{showAttach && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => fileInputRef.current?.click()}
							title="attach files (images inline, text pasted, binaries uploaded)"
						>
							<Paperclip size={12} /> <span className="sh-btn-label">Attach</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
			<input ref={fileInputRef} type="file" multiple hidden onChange={onFileInput} />
		</div>
	);
}
