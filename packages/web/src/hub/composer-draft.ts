/**
 * Per-session composer drafts, keyed by hub session id. Module-level so the
 * unsent prompt — text plus staged attachments — survives surface remounts:
 * switching sessions unmounts the vendored `Composer`, which starts empty
 * unless re-seeded. Same shape as the steering queue's store: browser-local,
 * cleared when the buffer is sent empty, lost on reload.
 */
import type { ComposerDraft } from "../components/shell/Composer";

const draftBySession = new Map<string, ComposerDraft>();

const EMPTY_DRAFT: ComposerDraft = { text: "", staged: [] };

/** Draft for a session, or the shared empty draft when none is stored. */
export function getComposerDraft(sessionId: string): ComposerDraft {
	return draftBySession.get(sessionId) ?? EMPTY_DRAFT;
}

/**
 * Store the latest buffer. Mid-upload chips are dropped: their upload promise
 * died with the surface that started it, so restoring one would spin forever;
 * `ready`/`error` uploads keep their machine-side paths and are kept.
 */
export function setComposerDraft(sessionId: string, draft: ComposerDraft): void {
	const staged = draft.staged.filter(item => !(item.kind === "upload" && item.state === "uploading"));
	if (draft.text === "" && staged.length === 0) draftBySession.delete(sessionId);
	else draftBySession.set(sessionId, { text: draft.text, staged });
}

/** Drop a session's draft (post-delete cleanup); a no-op for unknown ids. */
export function forgetComposerDraft(sessionId: string): void {
	draftBySession.delete(sessionId);
}
