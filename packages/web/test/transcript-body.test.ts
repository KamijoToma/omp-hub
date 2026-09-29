import { afterEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantMessage, SessionEntry, WireMessage } from "../src/lib/wire";
import { parseTranscriptMode, setTranscriptMode } from "../src/lib/transcript-mode";
import { summarizeTurn } from "../src/lib/turn-summary";

// Import after installing the SSR-only HTMLElement shim: the shared tool
// renderer subclasses HTMLElement at module evaluation time.
globalThis.HTMLElement ??= class {} as typeof HTMLElement;
const { Transcript } = await import("../src/components/transcript/Transcript");

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
const stamp = "2026-09-29T12:00:00Z";

function assistant(content: AssistantMessage["content"], duration?: number): AssistantMessage {
	return { role: "assistant", content, model: "test", usage, stopReason: "stop", duration, timestamp: 1 };
}

function entry(id: string, message: WireMessage): SessionEntry {
	return { id, type: "message", parentId: null, timestamp: stamp, message };
}

function render(entries: SessionEntry[], options: { stream?: AssistantMessage | null; working?: boolean; hasMoreHistory?: boolean } = {}): string {
	return renderToStaticMarkup(React.createElement(Transcript, {
		entries,
		stream: options.stream ?? null,
		streamDone: false,
		activeTools: new Map(),
		working: options.working ?? false,
		hasMoreHistory: options.hasMoreHistory,
	}));
}

afterEach(() => setTranscriptMode("full"));

test("body-only hides non-answer output without losing user input or the answer", () => {
	const entries = [
		entry("u", { role: "user", content: "Question", timestamp: 1 }),
		entry("a", assistant([
			{ type: "thinking", thinking: "hidden reasoning" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "private command" } },
			{ type: "text", text: "Final **answer**" },
		], 2300)),
		entry("c", { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "private result" }], isError: false, timestamp: 2 }),
	];
	const full = render(entries);
	expect(full).toContain("tr-think-head");
	expect(full).toContain("private command");
	expect(full).toContain("tr-usage");
	setTranscriptMode("body");
	const body = render(entries);
	expect(body).toContain("Question");
	expect(body).toContain("Final <strong>answer</strong>");
	expect(body).toContain("think for ~2.3s · used 1 tool");
	expect(body).not.toContain("hidden reasoning");
	expect(body).not.toContain("private command");
	expect(body).not.toContain("private result");
	expect(body).not.toContain("tr-usage");
	expect(body).not.toContain("tr-turn-model");
});

test("hidden diagnostics and synthetic prompts do not split one answer or appear as text", () => {
	setTranscriptMode("body");
	const entries: SessionEntry[] = [
		entry("u", { role: "user", content: "Question", timestamp: 1 }),
		entry("a1", assistant([{ type: "text", text: "Part one" }], 1000)),
		{ type: "custom_message", id: "diag", parentId: "a1", timestamp: stamp, customType: "notice", content: "private notice", display: true },
		entry("auto", { role: "user", content: "hidden synthetic prompt", synthetic: true, timestamp: 2 }),
		entry("a2", assistant([{ type: "text", text: "Part two" }], 2000)),
	];
	const html = render(entries);
	expect(html).toContain("Part one");
	expect(html).toContain("Part two");
	expect(html).toContain("think for ~3.0s · used 0 tools");
	expect(html.match(/class="tr-footnote"/g)).toHaveLength(1);
	expect(html).not.toContain("private notice");
	expect(html).not.toContain("hidden synthetic prompt");
});

test("tool-only turns and streaming ghosts retain one deduplicated count", () => {
	setTranscriptMode("body");
	const call = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: {} };
	const entries = [entry("u", { role: "user" as const, content: "Question", timestamp: 1 }), entry("a", assistant([call], 1000))];
	const stream = assistant([call, { type: "text", text: "Streaming answer" }]);
	const html = render(entries, { stream, working: true });
	expect(html).toContain("Streaming answer");
	expect(html).toContain("working… · used 1 tool");
	const complete = render(entries);
	expect(complete).toContain("think for ~1.0s · used 1 tool");
	expect(complete).not.toContain("Streaming answer");
});

test("missing timing and incomplete history do not masquerade as measured zero", () => {
	setTranscriptMode("body");
	const entries = [entry("a", assistant([{ type: "text", text: "Answer" }]))];
	const html = render(entries, { hasMoreHistory: true });
	expect(html).toContain("think time unavailable · used 0 tools · partial history");
	expect(html).not.toContain("think for ~0ms");
	expect(summarizeTurn([entry("a", assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }], 800))], null, false, [{ toolCallId: "c", toolName: "read", args: {}, startedAt: 1 }]).tools).toBe(1);
});

test("a failed answer stays visible as a footnote and a clear boundary separates turns", () => {
	setTranscriptMode("body");
	const failed = { ...assistant([], 0), stopReason: "error" as const, errorMessage: "private failure detail" };
	const entries: SessionEntry[] = [
		entry("u", { role: "user", content: "Question", timestamp: 1 }),
		entry("a", failed),
		{ type: "reset_boundary", id: "reset", parentId: "a", timestamp: stamp },
		entry("next", assistant([{ type: "text", text: "Fresh answer" }], 1500)),
	];
	const html = render(entries);
	expect(html).toContain("think for ~0ms · used 0 tools · error");
	expect(html).toContain("think for ~1.5s · used 0 tools");
	expect(html.match(/class="tr-footnote"/g)).toHaveLength(2);
	expect(html).not.toContain("private failure detail");
	expect(html).not.toContain("context cleared");
});

test("unknown stored preference fails open to the full transcript", () => {
	expect(parseTranscriptMode(null)).toBe("full");
	expect(parseTranscriptMode("unexpected")).toBe("full");
	expect(parseTranscriptMode("body")).toBe("body");
});
