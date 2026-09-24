/**
 * Prompt-payload text extraction for the auto-title hook (docs/protocol.md §2
 * `generate-title` context): collab prompt entries and user messages both feed
 * `maybeStartTitleGeneration`/`generateTitle`, which need the first text.
 */
import { describe, expect, test } from "bun:test";
import { firstText, firstUserText } from "../src/session-host";

describe("firstText", () => {
	// Typed const, not inline literal: the helper's structural param has no
	// `data` field, and fresh literals trip excess-property checks.
	const imageBlock: { type: string; data?: string } = { type: "image", data: "z4s=" };

	test("returns bare string payloads verbatim", () => {
		expect(firstText("fix the login bug")).toBe("fix the login bug");
		expect(firstText("")).toBe("");
	});

	test("picks the first text block from mixed content", () => {
		expect(firstText([imageBlock, { type: "text", text: "look at this" }])).toBe("look at this");
		expect(firstText([{ type: "text", text: "first" }, { type: "text", text: "second" }])).toBe("first");
	});

	test("returns undefined for image-only payloads and absent content", () => {
		expect(firstText([imageBlock])).toBeUndefined();
		expect(firstText(undefined)).toBeUndefined();
	});
});

describe("firstUserText", () => {
	test("finds the first user-role message text", () => {
		expect(
			firstUserText([
				{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
				{ role: "user", content: "fix the login bug" },
			]),
		).toBe("fix the login bug");
	});

	test("falls through to custom messages — collab prompts are never user-role", () => {
		// Typed const: `customType` is real on custom messages but absent from
		// the structural param, and fresh literals trip excess-property checks.
		const collabPrompt: { role: string; content?: string } & { customType?: string } = {
			role: "custom",
			content: "collab prompt text",
			customType: "collab-prompt",
		};
		expect(firstUserText([collabPrompt, { role: "assistant", content: "answer" }])).toBe("collab prompt text");
		expect(firstUserText([{ role: "assistant", content: "only an answer" }])).toBeUndefined();
	});
});
