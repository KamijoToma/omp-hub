/**
 * `composer-draft` — the per-session unsent-prompt store: round-trip per id,
 * mid-upload chips dropped while ready/error survive, empty buffers deleted.
 */
import { describe, expect, test } from "bun:test";
import type { ComposerDraft, Staged } from "../src/components/shell/Composer";
import { forgetComposerDraft, getComposerDraft, setComposerDraft } from "../src/hub/composer-draft";

function draft(text: string, staged: Staged[] = []): ComposerDraft {
	return { text, staged };
}

describe("composer draft store", () => {
	test("unknown sessions get the shared empty draft", () => {
		expect(getComposerDraft("s_missing")).toEqual({ text: "", staged: [] });
	});

	test("stores and restores per session id", () => {
		const staged: Staged[] = [{ kind: "paste", id: 1, content: "body", expansion: "body" }];
		setComposerDraft("s_a", draft("fix the flake", staged));
		setComposerDraft("s_b", draft("other"));
		expect(getComposerDraft("s_a")).toEqual({ text: "fix the flake", staged });
		expect(getComposerDraft("s_b").text).toBe("other");
	});

	test("mid-upload chips are dropped; ready and error uploads survive", () => {
		setComposerDraft("s_c", draft("see attached", [
			{ kind: "upload", id: 1, name: "busy.bin", bytes: 1, state: "uploading" },
			{ kind: "upload", id: 2, name: "done.bin", bytes: 2, state: "ready", path: "/srv/done.bin" },
			{ kind: "upload", id: 3, name: "bad.bin", bytes: 3, state: "error", error: "denied" },
		]));
		expect(getComposerDraft("s_c").staged).toEqual([
			{ kind: "upload", id: 2, name: "done.bin", bytes: 2, state: "ready", path: "/srv/done.bin" },
			{ kind: "upload", id: 3, name: "bad.bin", bytes: 3, state: "error", error: "denied" },
		]);
	});

	test("an emptied buffer deletes the entry", () => {
		setComposerDraft("s_d", draft("temp"));
		setComposerDraft("s_d", draft(""));
		expect(getComposerDraft("s_d")).toBe(getComposerDraft("s_missing"));
	});

	test("forget drops the entry; unknown ids are a no-op", () => {
		setComposerDraft("s_e", draft("bye"));
		forgetComposerDraft("s_e");
		expect(getComposerDraft("s_e").text).toBe("");
		forgetComposerDraft("s_unknown");
	});
});
