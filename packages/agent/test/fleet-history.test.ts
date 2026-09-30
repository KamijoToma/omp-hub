import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { queryStoredSessionMessages, readStoredSessionMessage, readStoredSessionMessages, searchStoredSessionMessages } from "../src/machine-cmds";

test("terminal fleet history reads the active branch without modifying its file or escaping the session store", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fleet-history-test-"));
	const root = path.join(dir, "agent", "sessions");
	try {
		await mkdir(root, { recursive: true });
		const manager = SessionManager.create(dir, root);
		manager.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "second question", timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("SDK did not persist a session file");
		const before = await readFile(file, "utf8");
		const first = await readStoredSessionMessages(file, undefined, 1, { sessionRoots: [root] });
		expect(first.messages[0]).toMatchObject({ role: "user", content: "second question" });
		expect(first.hasMore).toBe(true);
		const second = await readStoredSessionMessages(file, first.nextCursor!, 1, { sessionRoots: [root] });
		expect(second.messages[0]).toMatchObject({ role: "user", content: "first question" });
		expect(second.hasMore).toBe(false);
		expect(await readFile(file, "utf8")).toBe(before);

		const outsider = path.join(dir, "other.jsonl");
		await writeFile(outsider, before);
		const link = path.join(root, "escape.jsonl");
		await symlink(outsider, link);
		await expect(readStoredSessionMessages(link, undefined, 1, { sessionRoots: [root] }))
			.rejects.toThrow("outside managed omp session stores");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("terminal search uses full stored text, does not write history and refuses escaped symlinks", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fleet-search-test-"));
	const root = path.join(dir, "agent", "sessions");
	try {
		await mkdir(root, { recursive: true });
		const manager = SessionManager.create(dir, root);
		manager.appendMessage({ role: "user", content: `${"a".repeat(2200)} git merge --abort`, timestamp: Date.now() });
		manager.appendMessage({ role: "toolResult", toolCallId: "tc1", toolName: "bash",
			content: [{ type: "text", text: `${"b".repeat(3000)} GIT MERGE failed` }], isError: true, timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("SDK did not persist a session file");
		const before = await readFile(file, "utf8");
		const newest = await searchStoredSessionMessages(file, { query: "git merge", limit: 1 }, { sessionRoots: [root] });
		expect(newest.hits.map(hit => hit.source)).toEqual(["toolResult"]);
		expect(newest.hasMore).toBe(true);
		const older = await searchStoredSessionMessages(file, { query: "GIT MERGE", cursor: newest.nextCursor! }, { sessionRoots: [root] });
		expect(older.hits[0]?.snippet).toContain("git merge --abort");
		expect(older.hasMore).toBe(false);
		expect(await readFile(file, "utf8")).toBe(before);
		const timeOnly = await searchStoredSessionMessages(file, { from: "2000-01-01T00:00:00Z" }, { sessionRoots: [root] });
		expect(timeOnly.hits.map(hit => hit.id)).toEqual([older.hits[0]?.id, newest.hits[0]?.id]);
		const outsider = path.join(dir, "outside.jsonl");
		await writeFile(outsider, before);
		const link = path.join(root, "escape.jsonl");
		await symlink(outsider, link);
		await expect(searchStoredSessionMessages(link, { query: "git merge" }, { sessionRoots: [root] }))
			.rejects.toThrow("outside managed omp session stores");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("stored hits resolve to their tool pair and complete long output without changing the transcript", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fleet-evidence-test-"));
	const root = path.join(dir, "agent", "sessions");
	try {
		await mkdir(root, { recursive: true });
		const manager = SessionManager.create(dir, root);
		const commandId = manager.appendMessage({
			role: "assistant", api: "openai-completions", provider: "openai", model: "fixture",
			content: [
				{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "/docs/git merge main.md" } },
				{ type: "toolCall", id: "merge-call", name: "bash", arguments: { command: "git merge main", cwd: "/repo/prod" } },
			],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse", timestamp: Date.now(),
		});
		const unrelatedId = manager.appendMessage({ role: "toolResult", toolCallId: "read-call", toolName: "read",
			content: [{ type: "text", text: "Documentation only: git merge main" }], isError: false, timestamp: Date.now() });
		const output = `${"x".repeat(25_000)}\nFast-forward to 929d335`;
		const outputId = manager.appendMessage({ role: "toolResult", toolCallId: "merge-call", toolName: "bash",
			content: [{ type: "text", text: output }], isError: false, timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("SDK did not persist a session file");
		const original = await readFile(file, "utf8");
		const roots = { sessionRoots: [root] };
		const commands = await searchStoredSessionMessages(file, { query: "git merge main", roles: ["assistant"],
			toolNames: ["bash"], sources: ["toolCall"], fields: ["toolCall.arguments.command"] }, roots);
		expect(commands.hits.map(hit => [hit.id, hit.toolCallId])).toEqual([[commandId, "merge-call"]]);
		const context = await readStoredSessionMessage(file, {
			messageId: commandId, toolCallId: "merge-call", before: 0, after: 0,
		}, roots);
		expect(context.anchorId).toBe(commandId);
		expect(context.messages.map(message => message.id)).toEqual([commandId, outputId]);
		expect(context.messages.map(message => message.id)).not.toContain(unrelatedId);
		const result = await searchStoredSessionMessages(file, { query: "Fast-forward", sources: ["toolResult"] }, roots);
		const hit = result.hits[0];
		if (!hit?.match?.contentCursor) throw new Error("stored output hit omitted its content location");
		const near = await readStoredSessionMessage(file, {
			messageId: outputId, before: 0, after: 0, contentCursor: hit.match.contentCursor,
		}, roots);
		expect(near.content?.value).toContain("Fast-forward to 929d335");
		let cursor = context.messages.find(message => message.id === outputId)?.contentCursor;
		if (!cursor) throw new Error("long output omitted its full-content cursor");
		let reconstructed = "";
		while (cursor) {
			const page = await readStoredSessionMessage(file, {
				messageId: outputId, before: 0, after: 0, contentCursor: cursor,
			}, roots);
			expect(page.content?.field).toBe("toolResult");
			expect(page.content?.offset).toBe(reconstructed.length);
			reconstructed += String(page.content?.value);
			cursor = page.content?.nextCursor ?? undefined;
		}
		expect(reconstructed).toBe(output);
		expect(await readFile(file, "utf8")).toBe(original);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("terminal SQL reads a managed persisted branch without writing history or following escaped symlinks", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fleet-sql-history-"));
	const root = path.join(dir, "agent", "sessions");
	try {
		await mkdir(root, { recursive: true });
		const manager = SessionManager.create(dir, root);
		manager.appendMessage({ role: "user", content: "persisted rollback", timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("SDK did not persist a session file");
		const before = await readFile(file, "utf8");
		const result = await queryStoredSessionMessages(file,
			"SELECT m.role, p.text FROM messages m JOIN parts p ON m.id=p.message_id WHERE p.text LIKE '%rollback%'",
			{ sessionRoots: [root] });
		expect(result.rows).toEqual([["user", "persisted rollback"]]);
		expect(await readFile(file, "utf8")).toBe(before);
		const outside = path.join(dir, "outside.jsonl");
		await writeFile(outside, before);
		await expect(queryStoredSessionMessages(outside, "SELECT * FROM messages", { sessionRoots: [root] }))
			.rejects.toThrow("outside managed omp session stores");
		const escaped = path.join(root, "escaped.jsonl");
		await symlink(outside, escaped);
		await expect(queryStoredSessionMessages(escaped, "SELECT * FROM messages", { sessionRoots: [root] }))
			.rejects.toThrow("outside managed omp session stores");
		await expect(queryStoredSessionMessages(file, "ATTACH '/etc/passwd' AS x", { sessionRoots: [root] }))
			.rejects.toThrow("invalid SQL:");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
