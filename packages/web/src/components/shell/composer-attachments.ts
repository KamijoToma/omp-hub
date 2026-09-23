/**
 * Pure helpers behind the composer's attachment handling: large-paste collapse,
 * marker expansion, text-file classification, and upload name sanitizing.
 * Mirrors the omp TUI editor's thresholds and formats (oh-my-pi
 * `packages/tui/src/components/editor.ts #handlePaste`) so pasted content
 * behaves the same in both frontends.
 *
 * Wire notes: staged images ride the collab `prompt` frame's `images` array;
 * text attachments inline as `<attachment>` blocks; binary files upload through
 * the hub (`POST /api/sessions/:id/files`) and are referenced by absolute path.
 */

import type { ImageContent } from "../../lib/wire";

/** Above either threshold a paste collapses to a `[Paste #N]` marker instead of flooding the box. */
export const PASTE_LINE_THRESHOLD = 10;
export const PASTE_CHAR_THRESHOLD = 1000;

/** Text files larger than this upload to the machine instead of inlining into the prompt. */
export const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

/** Hard cap on image attachments staged from paste or picker (per image, raw bytes). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Hard cap on a single hub file upload (raw bytes; must match the hub's limit). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** `[Paste #3]`, `[Paste #3, +42 lines]`, `[Paste #3, 1234 chars]`, `[Paste #3, report.pdf]`. */
const PASTE_MARKER_SOURCE = `\\[Paste #(\\d+)(?:, [^\\]\\n]*)?\\]`;

/** True when a paste should collapse to a marker rather than insert inline. */
export function isLargePaste(text: string): boolean {
	return text.split("\n").length > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

/** Collapsed marker for paste `n`: named form for file attachments, else line/char count. */
export function pasteMarker(n: number, text: string, name?: string): string {
	if (name) return `[Paste #${n}, ${name}]`;
	const lines = text.split("\n").length;
	return lines > PASTE_LINE_THRESHOLD ? `[Paste #${n}, +${lines} lines]` : `[Paste #${n}, ${text.length} chars]`;
}

/** Strip every `[Paste #n, …]` marker occurrence (chip removal); `#3` must not match `#30`. */
export function removePasteMarkers(text: string, n: number): string {
	return text.replace(new RegExp(`\\[Paste #${n}(?!\\d)(?:,[^\\]\\n]*)?\\]`, "g"), "").trimEnd();
}

/**
 * Single-pass replacement of `[Paste #N]` markers with their stored content.
 * Markers without a staged id stay literal (the user may have typed one), and
 * a pasted body that itself contains a marker-looking string is never rescanned.
 */
export function expandPasteMarkers(text: string, contents: ReadonlyMap<number, string>): string {
	if (contents.size === 0 || !text.includes("[Paste #")) return text;
	return text.replace(new RegExp(PASTE_MARKER_SOURCE, "g"), (match, id: string) => {
		const content = contents.get(Number(id));
		return content === undefined ? match : content;
	});
}

/** Wrap inline text content so the model treats it as one quoted block (TUI parity). */
export function wrapAttachment(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Media types the collab `prompt.images` channel accepts. */
export function isImageFile(file: { type: string; name: string }): boolean {
	if (file.type.startsWith("image/")) return true;
	// Clipboard/drag sources on some platforms report an empty type with a telling extension.
	return /^[^?#]+\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name);
}

const TEXT_EXTENSIONS: Record<string, true> = {
	".txt": true, ".md": true, ".markdown": true, ".rst": true, ".json": true, ".jsonl": true, ".ndjson": true,
	".csv": true, ".tsv": true, ".toml": true, ".yaml": true, ".yml": true, ".xml": true, ".html": true,
	".htm": true, ".css": true, ".scss": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".ts": true, ".tsx": true, ".mts": true, ".cts": true, ".py": true, ".rb": true, ".rs": true, ".go": true,
	".c": true, ".h": true, ".cc": true, ".cpp": true, ".hpp": true, ".java": true, ".kt": true, ".swift": true,
	".php": true, ".lua": true, ".sh": true, ".bash": true, ".zsh": true, ".fish": true, ".ps1": true,
	".sql": true, ".graphql": true, ".proto": true, ".ini": true, ".cfg": true, ".conf": true, ".env": true,
	".gitignore": true, ".dockerfile": true, ".makefile": true, ".log": true, ".patch": true, ".diff": true,
	".srt": true, ".vue": true, ".svelte": true, ".astro": true,
};

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/yaml", "application/toml", "application/javascript", "application/typescript", "application/x-sh", "application/x-yaml", "application/ld+json", "image/svg"];

/**
 * Classify a picked/pasted/dropped file: images go to the wire `images` array,
 * text-ish files inline as `<attachment>` blocks, everything else uploads.
 */
export function classifyFile(file: { type: string; name: string; size: number }): "image" | "text" | "binary" {
	if (isImageFile(file)) return "image";
	const dot = file.name.lastIndexOf(".");
	const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : file.name.toLowerCase();
	if (file.size <= MAX_INLINE_TEXT_BYTES && (TEXT_MIME_PREFIXES.some(p => file.type.startsWith(p)) || TEXT_EXTENSIONS[ext])) {
		return "text";
	}
	return "binary";
}

/** Strip directory components, control characters, and dangerous names; cap length. */
export function sanitizeUploadName(name: string): string {
	const base = name.replace(/^.*[\\/]/, "").replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!base || base === "." || base === "..") return "file";
	return base.length > 128 ? `${base.slice(0, 100)}…${base.slice(-24)}` : base;
}

/** `12 B`, `1.5 KB`, `3.2 MB` — chip label sizing. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a File as bare base64 (no data: URL prefix) for wire `ImageContent.data`. */
export function fileToBase64(file: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onerror = () => reject(reader.error ?? new Error("read failed"));
	reader.onload = () => {
		const url = String(reader.result);
		const comma = url.indexOf(",");
		resolve(comma >= 0 ? url.slice(comma + 1) : url);
	};
	reader.readAsDataURL(file);
	return promise;
}

/** Wire image content for a staged image file. */
export async function imageContentFromFile(file: File): Promise<ImageContent> {
	return { type: "image", data: await fileToBase64(file), mimeType: file.type || guessImageMime(file.name) };
}

function guessImageMime(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
	switch (ext) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "bmp":
			return "image/bmp";
		case "avif":
			return "image/avif";
		default:
			return "image/png";
	}
}
