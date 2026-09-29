import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readStoredSessionMessages } from "../src/machine-cmds";

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
		expect(first.messages[0]).toMatchObject({ role: "user", content: "first question" });
		expect(first.hasMore).toBe(true);
		const second = await readStoredSessionMessages(file, first.nextCursor!, 1, { sessionRoots: [root] });
		expect(second.messages[0]).toMatchObject({ role: "user", content: "second question" });
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
