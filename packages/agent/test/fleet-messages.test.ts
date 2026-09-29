import { expect, test } from "bun:test";
import { pageFleetMessages } from "../src/fleet-client";

const entries = [
	{ id: "root", parentId: null, timestamp: "t1", type: "session" },
	{ id: "a", parentId: "root", timestamp: "t2", type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
	{ id: "b", parentId: "a", timestamp: "t3", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] } },
	{ id: "c", parentId: "b", timestamp: "t4", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "data" }] } },
	{ id: "d", parentId: "c", timestamp: "t5", type: "custom_message", content: "a pushed notice" },
];

const session = { getBranch: () => entries, getLeafId: () => "d" };

test("structured history pages message roles and content without discarding tool output or custom notices", () => {
	const first = pageFleetMessages(session, undefined, 2);
	expect(first.messages.map(message => [message.id, message.role])).toEqual([["a", "user"], ["b", "assistant"]]);
	expect(first.messages[1]?.content).toEqual([{ type: "toolCall", name: "read", arguments: { path: "x" } }]);
	expect(first.nextCursor).toBe("b");
	expect(first.hasMore).toBe(true);
	const second = pageFleetMessages(session, first.nextCursor!, 2);
	expect(second.messages.map(message => [message.id, message.role, message.content])).toEqual([
		["c", "toolResult", [{ type: "text", text: "data" }]],
		["d", "custom", "a pushed notice"],
	]);
	expect(second.hasMore).toBe(false);
	expect(second.leafId).toBe("d");
});

test("cursor must belong to the active branch and limits are bounded", () => {
	expect(() => pageFleetMessages(session, "fork", 1)).toThrow("cursor is not on the active branch");
	expect(() => pageFleetMessages(session, undefined, 101)).toThrow("limit must be between 1 and 100");
	const exhausted = pageFleetMessages(session, "d");
	expect(exhausted.messages).toEqual([]);
	expect(exhausted.nextCursor).toBe("d");
});

test("fleet history removes image payloads and bounds oversized tool output while retaining identifiers", () => {
	const privateImage = "base64-image-secret";
	const hugeOutput = "x".repeat(20_000);
	const source = { getLeafId: () => "last", getBranch: () => [
		{ id: "image", parentId: null, timestamp: "t1", type: "message", message: { role: "user",
			content: [{ type: "image", mimeType: "image/png", data: privateImage }] } },
		{ id: "tool", parentId: "image", timestamp: "t2", type: "message", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash",
			isError: true, content: [{ type: "text", text: hugeOutput }] } },
		{ id: "hidden", parentId: "tool", timestamp: "t3", type: "custom_message", display: false, content: "hidden rule" },
	] };
	const result = pageFleetMessages(source);
	expect(result.messages[0]).toMatchObject({ role: "user", truncated: true,
		content: [{ type: "image", mimeType: "image/png", omitted: true }] });
	expect(result.messages[1]).toMatchObject({ role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: true,
		truncated: true });
	expect(result.messages[1]?.content).toEqual([{ type: "text", text: hugeOutput.slice(0, 2000) }]);
	expect(result.messages.map(message => message.id)).toEqual(["image", "tool"]);
});
