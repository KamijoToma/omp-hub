/**
 * Pure helpers behind the late-diagnostics transcript card: `<system-notice>`
 * wrapper stripping (phase 2) and tolerant `details.files` parsing (phase 1).
 */
import { describe, expect, test } from "bun:test";
import { stripSystemNotice } from "../src/lib/system-notice";
import { lateDiagnosticsFiles } from "../src/components/transcript/LateDiagnostics";

describe("stripSystemNotice", () => {
	test("strips a plain wrapper and trims the inner text", () => {
		expect(stripSystemNotice("<system-notice>\nLate LSP diagnostics arrived.\n</system-notice>")).toBe(
			"Late LSP diagnostics arrived.",
		);
	});

	test("strips wrappers with attributes", () => {
		expect(
			stripSystemNotice('<system-notice reason="background_task_dispatched" job="j1">\nTask text.\n</system-notice>'),
		).toBe("Task text.");
	});

	test("tolerates leading whitespace before the wrapper", () => {
		expect(stripSystemNotice("  \n<system-notice>inner</system-notice>")).toBe("inner");
	});

	test("passes through text without a wrapper", () => {
		const text = "plain custom message body";
		expect(stripSystemNotice(text)).toBe(text);
	});

	test("passes through an unclosed wrapper", () => {
		const text = "<system-notice>\nnever closed";
		expect(stripSystemNotice(text)).toBe(text);
	});

	test("passes through text outside the wrapper (not an exact-message wrapper)", () => {
		const text = "<system-notice>a</system-notice>\ntrailing body";
		expect(stripSystemNotice(text)).toBe(text);
	});

	test("leaves a double wrapper intact except for one outer layer", () => {
		// Only one outer wrapper is stripped; the inner one stays visible.
		expect(stripSystemNotice("<system-notice><system-notice>x</system-notice></system-notice>")).toBe(
			"<system-notice>x</system-notice>",
		);
	});
});

describe("lateDiagnosticsFiles", () => {
	test("parses a valid details payload", () => {
		const files = lateDiagnosticsFiles({
			files: [
				{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["TS2322: ..."] },
				{ path: "src/b.ts", summary: "clean", errored: false, messages: [] },
			],
		});
		expect(files).toEqual([
			{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["TS2322: ..."] },
			{ path: "src/b.ts", summary: "clean", errored: false, messages: [] },
		]);
	});

	test("returns null for missing or malformed details", () => {
		expect(lateDiagnosticsFiles(undefined)).toBeNull();
		expect(lateDiagnosticsFiles(null)).toBeNull();
		expect(lateDiagnosticsFiles("nope")).toBeNull();
		expect(lateDiagnosticsFiles([])).toBeNull();
		expect(lateDiagnosticsFiles({})).toBeNull();
		expect(lateDiagnosticsFiles({ files: "three" })).toBeNull();
		expect(lateDiagnosticsFiles({ files: [] })).toBeNull();
	});

	test("coerces field types and skips non-object entries", () => {
		const files = lateDiagnosticsFiles({
			files: [
				42,
				{ path: 7, summary: null, errored: "yes", messages: ["ok", 5, null] },
			],
		});
		expect(files).toEqual([{ path: undefined, summary: undefined, errored: false, messages: ["ok"] }]);
	});
});
