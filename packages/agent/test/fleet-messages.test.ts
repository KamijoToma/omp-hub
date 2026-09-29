import { expect, test } from "bun:test";
import { pageFleetMessages, searchFleetMessages } from "../src/fleet-client";

const entries = [
	{ id: "root", parentId: null, timestamp: "t1", type: "session" },
	{ id: "a", parentId: "root", timestamp: "t2", type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
	{ id: "b", parentId: "a", timestamp: "t3", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] } },
	{ id: "c", parentId: "b", timestamp: "t4", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "data" }] } },
	{ id: "d", parentId: "c", timestamp: "t5", type: "custom_message", content: "a pushed notice" },
];

const session = { getBranch: () => entries, getLeafId: () => "d" };

test("structured history starts at recent messages, then pages older context in chronological order", () => {
	const latest = pageFleetMessages(session, undefined, 2);
	expect(latest.messages.map(message => [message.id, message.role, message.content])).toEqual([
		["c", "toolResult", [{ type: "text", text: "data" }]],
		["d", "custom", "a pushed notice"],
	]);
	expect(latest.nextCursor).toBe("c");
	expect(latest.hasMore).toBe(true);
	const older = pageFleetMessages(session, latest.nextCursor!, 2);
	expect(older.messages.map(message => [message.id, message.role])).toEqual([["a", "user"], ["b", "assistant"]]);
	expect(older.messages[1]?.content).toEqual([{ type: "toolCall", name: "read", arguments: { path: "x" } }]);
	expect(older.nextCursor).toBe("a");
	expect(older.hasMore).toBe(false);
	expect(older.leafId).toBe("d");
});

test("a rewind invalidates a previous page cursor and limits remain bounded", () => {
	let branch = entries.slice();
	const manager = { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null };
	const cursor = pageFleetMessages(manager, undefined, 2).nextCursor!;
	branch = branch.slice(0, 2);
	expect(() => pageFleetMessages(manager, cursor, 1)).toThrow("cursor is not on the active branch");
	expect(() => pageFleetMessages(session, undefined, 101)).toThrow("limit must be between 1 and 100");
	const exhausted = pageFleetMessages(session, "a");
	expect(exhausted.messages).toEqual([]);
	expect(exhausted.nextCursor).toBe("a");
	expect(exhausted.hasMore).toBe(false);
});

test("the default page is the latest 20 visible messages; an appended turn does not change older pages", () => {
	const branch: Array<{ id: string; parentId: string | null; timestamp: string; type: string;
		message?: { role: string; content?: string }; content?: string; display?: boolean }> = Array.from({ length: 31 }, (_, index) => ({
		id: `m${index}`, parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: `t${index}`, type: "message", message: { role: "user", content: `turn ${index}` },
	}));
	branch.push({ id: "hidden", parentId: "m30", timestamp: "t31", type: "custom_message",
		content: "not for fleet", display: false });
	const manager = { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null };
	const latest = pageFleetMessages(manager);
	expect(latest.messages.map(message => message.id)).toEqual(Array.from({ length: 20 }, (_, index) => `m${index + 11}`));
	expect(latest.nextCursor).toBe("m11");
	expect(latest.hasMore).toBe(true);
	branch.push({ id: "m31", parentId: "hidden", timestamp: "t32", type: "message",
		message: { role: "user", content: "new turn" } });
	const older = pageFleetMessages(manager, latest.nextCursor!);
	expect(older.messages.map(message => message.id)).toEqual(Array.from({ length: 11 }, (_, index) => `m${index}`));
	expect(older.nextCursor).toBe("m0");
	expect(older.hasMore).toBe(false);
	expect(older.leafId).toBe("m31");
});

test("the payload budget keeps the newest turns and pages older oversized results", () => {
	const text = "x".repeat(2000);
	const blocks = Array.from({ length: 12 }, () => ({ type: "text", text }));
	const branch = Array.from({ length: 4 }, (_, index) => ({
		id: `m${index}`, parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: `t${index}`, type: "message", message: { role: "toolResult", content: blocks },
	}));
	const manager = { getBranch: () => branch, getLeafId: () => "m3" };
	const latest = pageFleetMessages(manager);
	expect(latest.messages.map(message => message.id)).toEqual(["m2", "m3"]);
	expect(latest.nextCursor).toBe("m2");
	expect(latest.hasMore).toBe(true);
	const older = pageFleetMessages(manager, latest.nextCursor!);
	expect(older.messages.map(message => message.id)).toEqual(["m0", "m1"]);
	expect(older.hasMore).toBe(false);
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

test("search uses untruncated stored blocks and nested tool arguments without leaking hidden content", () => {
	const timestamp = "2026-09-30T12:00:00.000Z";
	const long = `${"x".repeat(2200)} Git Merge --abort ${"y".repeat(20_000)}`;
	const branch = [
		{ id: "text", parentId: null, timestamp, type: "message", message: {
			role: "user", content: [{ type: "text", text: long }] } },
		{ id: "call", parentId: "text", timestamp, type: "message", message: {
			role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { nested: { command: "git merge --no-ff topic" } } }] } },
		{ id: "output", parentId: "call", timestamp, type: "message", message: {
			role: "toolResult", toolName: "bash", content: [{ type: "text", text: `${"z".repeat(3000)} git merge failure` }] } },
		{ id: "visible", parentId: "output", timestamp, type: "custom_message", content: "git merge alert", display: true },
		{ id: "hidden", parentId: "visible", timestamp, type: "custom_message", content: "git merge private", display: false },
		{ id: "image", parentId: "hidden", timestamp, type: "message", message: {
			role: "user", content: [{ type: "image", data: "git merge secret" }] } },
		{ id: "thinking", parentId: "image", timestamp, type: "message", message: {
			role: "assistant", content: [{ type: "thinking", text: "git merge secret" }] } },
	];
	const manager = { getBranch: () => branch, getLeafId: () => "thinking" };
	const page = searchFleetMessages(manager, { query: " GIT MERGE ", limit: 2 });
	expect(page.hits.map(hit => [hit.id, hit.source])).toEqual([["output", "toolResult"], ["visible", "custom"]]);
	expect(page.hasMore).toBe(true);
	expect(page.nextCursor).toBe("output");
	const earlier = searchFleetMessages(manager, { query: "git merge", cursor: page.nextCursor! });
	expect(earlier.hits.map(hit => [hit.id, hit.source])).toEqual([["text", "text"], ["call", "toolCall"]]);
	expect(earlier.hits[1]?.toolName).toBe("bash");
	expect(page.hits[0]?.toolName).toBe("bash");
	expect(earlier.hits[0]?.snippet.toLowerCase()).toContain("git merge --abort");
	expect(earlier.hits[0]?.snippet.length).toBeLessThanOrEqual(200);
	expect(earlier.hits[1]?.snippet).toContain("git merge --no-ff topic");
	expect(earlier.hasMore).toBe(false);
	expect(JSON.stringify([...page.hits, ...earlier.hits])).not.toContain("secret");
	expect(searchFleetMessages(manager, { query: "git merge --no-ff topic?" }).hits).toEqual([]);
	expect(JSON.stringify([...page.hits, ...earlier.hits])).not.toContain("y".repeat(500));
	const timeOnly = searchFleetMessages(manager, { from: timestamp });
	expect(timeOnly.hits.map(hit => hit.id)).not.toContain("hidden");
	expect(timeOnly.hits.filter(hit => hit.id === "image" || hit.id === "thinking").map(hit => hit.snippet))
		.toEqual(["", ""]);
});

test("time-bound search includes from, excludes to, and returns bounded previews", () => {
	const branch = [0, 1, 2, 3].map(index => ({
		id: `m${index}`, parentId: index ? `m${index - 1}` : null, type: "message",
		timestamp: `2026-09-30T12:0${index}:00Z`,
		message: { role: "user", content: index === 2 ? [{ type: "image", data: "private" }] : `${"q".repeat(500)} time ${index}` },
	}));
	const manager = { getBranch: () => branch, getLeafId: () => "m3" };
	const result = searchFleetMessages(manager, {
		from: "2026-09-30T12:01:00+00:00", to: "2026-09-30T12:03:00Z",
	});
	expect(result.hits.map(hit => [hit.id, hit.snippet.length])).toEqual([["m1", 200], ["m2", 0]]);
	expect(result.hits[1]?.snippet).toBe("");
	expect(result.hasMore).toBe(false);
	expect(searchFleetMessages(manager, { to: "2026-09-30T12:01:00Z" }).hits.map(hit => hit.id)).toEqual(["m0"]);
	expect(searchFleetMessages(manager, { query: "TIME 3", from: "2026-09-30T12:02:00Z" }).hits.map(hit => hit.id))
		.toEqual(["m3"]);
	expect(searchFleetMessages(manager, { from: "0099-01-01T00:00:00Z", query: "TIME 3" }).hits.map(hit => hit.id))
		.toEqual(["m3"]);
});

test("search validates filter inputs and rejects cursors removed by branch rewind", () => {
	let branch = entries.slice();
	const manager = { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null };
	const cursor = searchFleetMessages(manager, { query: "data" }).nextCursor!;
	branch = branch.slice(0, 2);
	expect(() => searchFleetMessages(manager, { query: "data", cursor })).toThrow("cursor is not on the active branch");
	for (const [options, error] of [
		[{}, "query, from, or to is required"],
		[{ query: " " }, "query must be between 1 and 256 characters"],
		[{ query: "x".repeat(257) }, "query must be between 1 and 256 characters"],
		[{ query: "x", limit: 51 }, "limit must be between 1 and 50"],
		[{ query: "x", limit: 1.5 }, "limit must be between 1 and 50"],
		[{ query: "x", cursor: "" }, "cursor must be between 1 and 128 characters"],
		[{ from: "2026-09-30T12:00:00" }, "from must be an ISO-8601 timestamp with timezone"],
		[{ from: "2026-02-30T12:00:00Z" }, "from must be an ISO-8601 timestamp with timezone"],
		[{ from: "2026-09-30T12:00:00Z", to: "2026-09-30T12:00:00Z" }, "from must be before to"],
	] as const) expect(() => searchFleetMessages(manager, options)).toThrow(error);
});
