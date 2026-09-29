import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readStoredSessionMessages, searchStoredSessionMessages } from "../src/machine-cmds";

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
