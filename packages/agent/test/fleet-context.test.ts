import { expect, test } from "bun:test";
import { getFleetMessage, searchFleetMessages, type FleetBranchEntry, type FleetBranchManager, type FleetMessageContext } from "../src/fleet-client";

const timestamp = "2026-09-30T12:00:00Z";

function managerFor(branch: FleetBranchEntry[]) {
	return { getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null };
}

function collectContent(manager: FleetBranchManager, messageId: string, initial: string) {
	const chunks: NonNullable<FleetMessageContext["content"]>[] = [];
	let cursor: string | null = initial;
	while (cursor !== null) {
		if (chunks.length > 100) throw new Error("continuation did not terminate");
		const content: NonNullable<FleetMessageContext["content"]> = getFleetMessage(manager, { messageId, before: 0, after: 0, contentCursor: cursor }).content!;
		chunks.push(content);
		cursor = content.nextCursor;
	}
	return chunks;
}

test("inclusive visible context pairs parallel tools by ID across nonadjacent out-of-order results", () => {
	const branch: FleetBranchEntry[] = [
		{ id: "question", parentId: null, timestamp, type: "message", message: { role: "user", content: "question" } },
		{ id: "calls", parentId: "question", timestamp, type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "tc-a", name: "read", arguments: { path: "a" } },
			{ type: "toolCall", id: "tc-b", name: "bash", arguments: { command: "b" } },
		] } },
		{ id: "unrelated", parentId: "calls", timestamp, type: "message", message: { role: "toolResult", toolCallId: "other", content: "not paired" } },
		{ id: "hidden", parentId: "unrelated", timestamp, type: "custom_message", display: false, content: "private hidden notice" },
		{ id: "notice", parentId: "hidden", timestamp, type: "custom_message", content: "visible notice" },
		{ id: "result-b", parentId: "notice", timestamp, type: "message", message: { role: "toolResult", toolCallId: "tc-b", toolName: "bash", content: "b result" } },
		{ id: "interleaved", parentId: "result-b", timestamp, type: "message", message: { role: "assistant", content: "working" } },
		{ id: "result-a", parentId: "interleaved", timestamp, type: "message", message: { role: "toolResult", toolCallId: "tc-a", toolName: "read", content: "a result" } },
	];
	const manager = managerFor(branch);
	const paired = getFleetMessage(manager, { messageId: "calls", before: 0, after: 0 });
	expect(paired.messages.map(row => row.id)).toEqual(["calls", "result-b", "result-a"]);
	expect(paired.relatedIds).toEqual(["result-b", "result-a"]);
	expect(paired.anchorId).toBe("calls");
	const restricted = getFleetMessage(manager, { messageId: "calls", before: 0, after: 0, toolCallId: "tc-b" });
	expect(restricted.messages.map(row => row.id)).toEqual(["calls", "result-b"]);
	expect(restricted.relatedIds).toEqual(["result-b"]);
	const resultAnchor = getFleetMessage(manager, { messageId: "result-b", before: 0, after: 0, toolCallId: "tc-b" });
	expect(resultAnchor.messages.map(row => row.id)).toEqual(["calls", "result-b"]);
	expect(resultAnchor.relatedIds).toEqual(["calls"]);
	const chronological = getFleetMessage(manager, { messageId: "notice", before: 1, after: 1 });
	expect(chronological.messages.map(row => row.id)).toEqual(["unrelated", "notice", "result-b"]);
	expect(() => getFleetMessage(manager, { messageId: "calls", toolCallId: "other" })).toThrow();
	expect(() => getFleetMessage(manager, { messageId: "hidden" })).toThrow();
});

test("a search hit beyond the preview is directly readable and the entire visible text stream reconstructs", () => {
	const output = `${"x".repeat(25_000)}\nTAIL MATCH\t${"y".repeat(9000)}`;
	const content = [
		{ type: "thinking", text: "private thinking payload" },
		{ type: "image", data: "private image payload", mimeType: "image/png" },
		{ type: "text", text: output },
		...Array.from({ length: 13 }, (_, index) => ({ type: "text", text: `extra block ${index}` })),
	];
	const branch: FleetBranchEntry[] = [{ id: "output", parentId: null, timestamp, type: "message", message: {
		role: "toolResult", toolCallId: "tc", toolName: "bash", content,
	} }];
	const manager = managerFor(branch);
	const hit = searchFleetMessages(manager, { query: "tail match" }).hits[0]!;
	expect(hit.match).toMatchObject({ blockIndex: 2, field: "toolResult", start: output.indexOf("TAIL MATCH"), end: output.indexOf("TAIL MATCH") + 10 });
	const near = getFleetMessage(manager, { messageId: hit.id, before: 0, after: 0, contentCursor: hit.match!.contentCursor });
	expect(near.content?.value).toContain("TAIL MATCH");
	expect(near.content?.offset).toBeGreaterThan(2000);
	const context = getFleetMessage(manager, { messageId: "output", before: 0, after: 0 });
	expect(JSON.stringify(context)).not.toContain("private");
	const chunks = collectContent(manager, "output", context.messages[0]!.contentCursor!);
	const textChunks = chunks.filter(chunk => chunk.blockIndex === 2);
	expect(textChunks.map(chunk => chunk.value).join("")).toBe(output);
	let offset = 0;
	for (const chunk of textChunks) {
		expect(chunk.offset).toBe(offset);
		expect((chunk.value as string).length).toBeLessThanOrEqual(8000);
		offset += (chunk.value as string).length;
	}
	expect(chunks.filter(chunk => chunk.blockIndex !== 2).map(chunk => [chunk.blockIndex, chunk.value]))
		.toEqual(Array.from({ length: 13 }, (_, index) => [index + 3, `extra block ${index}`]));
	expect(JSON.stringify(chunks)).not.toContain("private");
});

test("oversized structured arguments retain paths, complete string values, primitives and empty containers", () => {
	const command = `${"prefix ".repeat(3000)}git status${" tail".repeat(3000)}`;
	const args = { command, nested: { flags: [true, false, 42, null], empty: {}, list: [], text: "" }, paths: ["first", "second"] };
	const branch: FleetBranchEntry[] = [{ id: "call", parentId: null, timestamp, type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "tc", name: "bash", arguments: args },
	] } }];
	const manager = managerFor(branch);
	const hit = searchFleetMessages(manager, { query: "git status", fields: ["toolCall.arguments.command"] }).hits[0]!;
	expect(getFleetMessage(manager, { messageId: "call", contentCursor: hit.match!.contentCursor }).content?.value).toContain("git status");
	const context = getFleetMessage(manager, { messageId: "call", before: 0, after: 0 });
	expect(context.messages[0]?.truncated).toBe(true);
	const chunks = collectContent(manager, "call", context.messages[0]!.contentCursor!);
	expect(chunks.every(chunk => chunk.toolCallId === "tc" && chunk.toolName === "bash")).toBe(true);
	const leaves = new Map<string, unknown>();
	for (const chunk of chunks) {
		expect(chunk).toMatchObject({ messageId: "call", blockIndex: 0, field: "toolCall.arguments" });
		const key = JSON.stringify(chunk.argumentPath);
		if (typeof chunk.value === "string") {
			const previous = leaves.get(key) as string | undefined;
			expect(chunk.offset).toBe(previous?.length ?? 0);
			leaves.set(key, (previous ?? "") + chunk.value);
		} else leaves.set(key, chunk.value);
	}
	expect([...leaves]).toEqual([
		['["command"]', command], ['["nested","flags",0]', true], ['["nested","flags",1]', false],
		['["nested","flags",2]', 42], ['["nested","flags",3]', null], ['["nested","empty"]', {}],
		['["nested","list"]', []], ['["nested","text"]', ""], ['["paths",0]', "first"], ['["paths",1]', "second"],
	]);
});

test("message and continuation snapshots survive appends but reject mismatched leaves and rewinds", () => {
	const branch: FleetBranchEntry[] = [
		{ id: "a", parentId: null, timestamp, type: "message", message: { role: "user", content: "a".repeat(9000) } },
		{ id: "b", parentId: "a", timestamp, type: "message", message: { role: "user", content: "b" } },
	];
	const manager = managerFor(branch);
	const original = getFleetMessage(manager, { messageId: "a", leafId: "b" });
	const cursor = original.messages[0]!.contentCursor!;
	branch.push({ id: "c", parentId: "b", timestamp, type: "message", message: { role: "user", content: "c" } });
	expect(getFleetMessage(manager, { messageId: "a", leafId: "b" })).toEqual(original);
	expect(getFleetMessage(manager, { messageId: "a", contentCursor: cursor }).leafId).toBe("b");
	expect(getFleetMessage(manager, { messageId: "a" }).messages.map(row => row.id)).toEqual(["a", "b", "c"]);
	expect(() => getFleetMessage(manager, { messageId: "a", leafId: "c", contentCursor: cursor })).toThrow();
	expect(() => getFleetMessage(manager, { messageId: "b", contentCursor: cursor })).toThrow();
	branch.splice(1);
	expect(() => getFleetMessage(manager, { messageId: "a", contentCursor: cursor })).toThrow();
	expect(() => getFleetMessage(manager, { messageId: "a", leafId: "b" })).toThrow();
	expect(() => getFleetMessage(manager, { messageId: "b" })).toThrow();
});

test("context budget never drops the anchor and exposes omitted pair IDs for explicit retrieval", () => {
	const output = Array.from({ length: 12 }, () => ({ type: "text", text: "x".repeat(2000) }));
	const branch: FleetBranchEntry[] = [{ id: "calls", parentId: null, timestamp, type: "message", message: { role: "assistant", content: [
		...output, ...["a", "b", "c"].map(id => ({ type: "toolCall", id, name: "bash", arguments: { command: id } })),
	] } }];
	for (const id of ["a", "b", "c"]) branch.push({ id: `result-${id}`, parentId: branch.at(-1)!.id, timestamp, type: "message",
		message: { role: "toolResult", toolCallId: id, content: output } });
	const manager = managerFor(branch);
	const context = getFleetMessage(manager, { messageId: "calls", before: 0, after: 0 });
	expect(context.messages.map(row => row.id)).toEqual(["calls", "result-a"]);
	expect(context.relatedIds).toEqual(["result-a", "result-b", "result-c"]);
	expect(context.contextTruncated).toBe(true);
	const argumentChunks = collectContent(manager, "calls", context.messages[0]!.contentCursor!)
		.filter(chunk => chunk.field === "toolCall.arguments");
	expect(argumentChunks.map(chunk => [chunk.toolCallId, chunk.toolName, chunk.value]))
		.toEqual([["a", "bash", "a"], ["b", "bash", "b"], ["c", "bash", "c"]]);
	for (const id of ["result-b", "result-c"]) {
		const recovered = getFleetMessage(manager, { messageId: id, before: 0, after: 0 });
		expect(recovered.messages.find(row => row.id === id)?.content).toEqual(output);
	}
});

test("context validates ranges, identities and malformed or out-of-range content cursors", () => {
	const branch: FleetBranchEntry[] = [{ id: "a", parentId: null, timestamp, type: "message", message: { role: "user", content: "text" } }];
	const manager = managerFor(branch);
	for (const options of [
		{ messageId: "" }, { messageId: "missing" }, { messageId: "a", before: -1 }, { messageId: "a", after: 11 },
		{ messageId: "a", before: 0.5 }, { messageId: "a", leafId: "missing" }, { messageId: "a", toolCallId: "wrong" },
		{ messageId: "a", contentCursor: "invalid!" },
	]) expect(() => getFleetMessage(manager, options)).toThrow();
	const encode = (part: number, offset: number) => Buffer.from(JSON.stringify({ version: 1, messageId: "a", leafId: "a", part, offset })).toString("base64url");
	for (const cursor of [encode(1, 0), encode(0, 5), encode(-1, 0), encode(0, -1)]) {
		expect(() => getFleetMessage(manager, { messageId: "a", contentCursor: cursor })).toThrow();
	}
});
