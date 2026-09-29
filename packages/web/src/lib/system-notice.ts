/**
 * `<system-notice>` wrapper stripping for transcript display.
 *
 * The SDK wraps model-facing injected notices (late LSP diagnostics, tool
 * roster changes, background dispatches, …) in a `<system-notice>` XML pair.
 * That wrapper is a prompt convention, not UI: when such a message is user
 * visible, the transcript renders the inner text without the tag pair.
 */

const OPEN_RE = /^<system-notice(?:\s[^>]*)?>/;
const CLOSE_TAG = "</system-notice>";

/**
 * Strip one outer `<system-notice>` wrapper from a message body. Only an
 * exact-message wrapper is removed: if text remains outside the pair (or
 * there is no wrapper at all) the input passes through untouched.
 */
export function stripSystemNotice(text: string): string {
	const body = text.trimStart();
	const open = OPEN_RE.exec(body);
	if (!open) return text;
	const inner = body.slice(open[0].length);
	const close = inner.lastIndexOf(CLOSE_TAG);
	if (close === -1) return text;
	if (inner.slice(close + CLOSE_TAG.length).trim() !== "") return text;
	return inner.slice(0, close).trim();
}
