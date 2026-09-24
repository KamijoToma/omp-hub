/**
 * Prompt-payload text extraction for the auto-title hook (docs/protocol.md §2
 * `generate-title` context): collab prompt entries and user messages both feed
 * `maybeStartTitleGeneration`/`generateTitle`, which need the first text.
 */
import { describe, expect, test } from "bun:test";
import { firstText } from "../src/session-host";

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
