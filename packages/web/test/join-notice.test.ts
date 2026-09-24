/**
 * `isSelfJoinNotice` — the hub surface suppresses the collab host's join echo
 * for the local guest (every sidebar switch/reload joins the room); other
 * peers' joins and every other notice still surface.
 */
import { describe, expect, test } from "bun:test";
import { isSelfJoinNotice } from "../src/hub/join-notice";

describe("isSelfJoinNotice", () => {
	test("matches the host's exact join wording for the local name", () => {
		expect(isSelfJoinNotice("sky joined the collab session", "sky")).toBe(true);
		expect(isSelfJoinNotice("sky joined the collab session (read-only)", "sky")).toBe(true);
	});

	test("normalizes the name the way the host does (trim, 64-char slice)", () => {
		expect(isSelfJoinNotice("sky joined the collab session", "  sky  ")).toBe(true);
		const long = "x".repeat(80);
		// The host stamps the sliced name; the filter slices the display name to match.
		expect(isSelfJoinNotice(`${"x".repeat(64)} joined the collab session`, long)).toBe(true);
		// An unsliced 80-char name can never come from the host.
		expect(isSelfJoinNotice(`${long} joined the collab session`, long)).toBe(false);
	});

	test("keeps other peers' joins and unrelated notices", () => {
		expect(isSelfJoinNotice("rpc joined the collab session", "sky")).toBe(false);
		expect(isSelfJoinNotice("retry 1/5: overloaded", "sky")).toBe(false);
		expect(isSelfJoinNotice("compacting context (threshold)", "sky")).toBe(false);
	});

	test("never matches an empty display name", () => {
		expect(isSelfJoinNotice(" joined the collab session", "  ")).toBe(false);
	});
});
