/**
 * Composer attachment helpers: large-paste collapse, marker expansion, file
 * classification, and upload-name sanitizing (web-side of protocol behaviors
 * shared with the omp TUI editor's paste handling).
 */
import { describe, expect, test } from "bun:test";
import {
	classifyFile,
	expandPasteMarkers,
	formatBytes,
	isLargePaste,
	MAX_INLINE_TEXT_BYTES,
	pasteMarker,
	removePasteMarkers,
	sanitizeUploadName,
	wrapAttachment,
} from "../src/components/shell/composer-attachments";

describe("isLargePaste", () => {
	test("at the thresholds (10 lines / 1000 chars) stays inline", () => {
		expect(isLargePaste("a\nb\nc\nd\ne\nf\ng\nh\ni\nj")).toBe(false);
		expect(isLargePaste("x".repeat(1000))).toBe(false);
	});

	test("over either threshold collapses", () => {
		expect(isLargePaste("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk")).toBe(true);
		expect(isLargePaste(`${"x".repeat(1000)}y`)).toBe(true);
	});
});

describe("pasteMarker", () => {
	test("named form for file attachments", () => {
		expect(pasteMarker(3, "x", "report.pdf")).toBe("[Paste #3, report.pdf]");
	});

	test("line-count form above the line threshold, else char count", () => {
		const manyLines = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
		expect(pasteMarker(1, manyLines)).toBe(`[Paste #1, +12 lines]`);
		expect(pasteMarker(2, "x".repeat(1001))).toBe("[Paste #2, 1001 chars]");
	});
});

describe("expandPasteMarkers", () => {
	test("replaces multiple staged markers with their content", () => {
		const text = "before [Paste #2, +12 lines] middle [Paste #1, 1001 chars] after";
		const expanded = expandPasteMarkers(text, new Map([
			[1, "x".repeat(1001)],
			[2, "l0\nl1\nl2"],
		]));
		expect(expanded).toBe(`before l0\nl1\nl2 middle ${"x".repeat(1001)} after`);
	});

	test("unknown or user-typed marker ids stay literal", () => {
		const text = "keep [Paste #7] and [Paste #2, notes.md] as typed";
		expect(expandPasteMarkers(text, new Map([[1, "secret"]]))).toBe(text);
	});

	test("is a single pass: expanded content is never rescanned", () => {
		const expanded = expandPasteMarkers("[Paste #1]", new Map([[1, "[Paste #2, trap]"]]));
		expect(expanded).toBe("[Paste #2, trap]");
	});

	test("text without markers skips the map entirely", () => {
		expect(expandPasteMarkers("plain", new Map([[1, "content"]]))).toBe("plain");
	});
});

describe("removePasteMarkers", () => {
	test("strips every form without touching neighboring ids", () => {
		const text = "a[Paste #3]b[Paste #3, +12 lines]c[Paste #3, report.md]d[Paste #30]e";
		expect(removePasteMarkers(text, 3)).toBe("abcd[Paste #30]e");
	});

	test("text without the marker is unchanged", () => {
		expect(removePasteMarkers("no markers here", 3)).toBe("no markers here");
	});
});

describe("wrapAttachment", () => {
	test("matches the TUI host-side wrap format", () => {
		expect(wrapAttachment("line1\nline2")).toBe("<attachment>\nline1\nline2\n</attachment>");
	});
});

describe("sanitizeUploadName", () => {
	test("reduces paths to bare filenames", () => {
		expect(sanitizeUploadName("/etc/passwd")).toBe("passwd");
		expect(sanitizeUploadName("..\\..\\windows\\evil.exe")).toBe("evil.exe");
		expect(sanitizeUploadName("../../.ssh/id_rsa")).toBe("id_rsa");
	});

	test("strips control characters and handles empty input", () => {
		expect(sanitizeUploadName("re\u0000port.pdf")).toBe("report.pdf");
		expect(sanitizeUploadName("")).toBe("file");
		expect(sanitizeUploadName("..")).toBe("file");
	});

	test("caps pathological length while keeping the extension visible", () => {
		const name = sanitizeUploadName(`${"x".repeat(300)}.pdf`);
		expect(name.length).toBeLessThanOrEqual(128);
		expect(name.endsWith(".pdf")).toBe(true);
	});
});

describe("classifyFile", () => {
	test("images by mime type or extension", () => {
		expect(classifyFile({ type: "image/png", name: "a.png", size: 10 })).toBe("image");
		expect(classifyFile({ type: "", name: "shot.JPG", size: 10 })).toBe("image");
	});

	test("text files by mime prefix or known extension", () => {
		expect(classifyFile({ type: "text/plain", name: "a", size: 10 })).toBe("text");
		expect(classifyFile({ type: "application/json", name: "a.json", size: 10 })).toBe("text");
		expect(classifyFile({ type: "", name: "main.ts", size: 10 })).toBe("text");
	});

	test("oversize text and unknown binaries upload instead of inlining", () => {
		expect(classifyFile({ type: "text/plain", name: "big.log", size: MAX_INLINE_TEXT_BYTES + 1 })).toBe("binary");
		expect(classifyFile({ type: "application/octet-stream", name: "blob.bin", size: 10 })).toBe("binary");
	});
});

describe("formatBytes", () => {
	test("scales units at the 1024 boundaries", () => {
		expect(formatBytes(12)).toBe("12 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(Math.floor(3.2 * 1024 * 1024))).toBe("3.2 MB");
	});
});
