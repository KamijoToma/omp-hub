import { expect, test } from "bun:test";
import { queryBranchMessages, sqlQueryCommand } from "../src/sql-query";
import { selectVisibleBranch } from "../src/sql-projection";
import { assertSqlRuntimeSupport } from "../src/main";

const time = "2026-09-30T12:00:00Z";
const branch = [
	{ id: "user", parentId: null, timestamp: time, type: "message", message: { role: "user", content: "first request" } },
	{ id: "tool", parentId: "user", timestamp: "2026-09-30T12:01:00Z", type: "message", message: {
		role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { args: { command: `git merge --abort ${"x".repeat(2500)} targetneedle` } } }],
	} },
	{ id: "output", parentId: "tool", timestamp: "2026-09-30T12:02:00Z", type: "message", message: {
		role: "toolResult", toolName: "bash", content: [{ type: "text", text: "merge failed; rollback necessary" }],
	} },
	{ id: "private", parentId: "output", timestamp: "2026-09-30T12:03:00Z", type: "custom_message", display: false, content: "hidden session key" },
	{ id: "image", parentId: "private", timestamp: "2026-09-30T12:04:00Z", type: "message", message: { role: "user", content: [{ type: "image", data: "image secret" }] } },
	{ id: "thought", parentId: "image", timestamp: "2026-09-30T12:05:00Z", type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "thinking secret" }] } },
];
const manager = { getBranch: () => branch, getLeafId: () => "thought" };

test("daemon refuses Bun without the SQL authorizer before contacting the hub", () => {
	expect(() => assertSqlRuntimeSupport("1.3.14")).toThrow("Bun >=1.4.0");
});

test("binary IPC accepts fragmented headers and visible-branch JSON, and refuses oversized inputs", async () => {
	const bytes = new TextEncoder().encode(JSON.stringify(selectVisibleBranch(manager)));
	const child = Bun.spawn(sqlQueryCommand(), { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
	const header = new TextEncoder().encode(`${JSON.stringify({
		sql: "SELECT id,parent_id FROM messages WHERE id='image'", leafId: "thought", length: bytes.byteLength,
	})}\n`);
	await child.stdin.write(header.subarray(0, 4));
	await child.stdin.write(header.subarray(4));
	await child.stdin.write(bytes.subarray(0, 10));
	await child.stdin.write(bytes.subarray(10));
	child.stdin.end();
	const reply = await new Response(child.stdout).json() as { ok: boolean; data: { rows: unknown[][] } };
	await child.exited;
	expect(reply.ok).toBe(true);
	expect(reply.data.rows).toEqual([["image", "output"]]);

	const oversized = Bun.spawn(sqlQueryCommand(), { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
	await oversized.stdin.write(`${JSON.stringify({ sql: "SELECT 1", leafId: null, length: 128 * 1024 * 1024 + 1 })}\n`);
	oversized.stdin.end();
	const rejected = await new Response(oversized.stdout).json() as { ok: boolean; error: string };
	await oversized.exited;
	expect(rejected).toEqual({ ok: false, error: "invalid SQL: invalid query frame" });
});

test("SQL JOIN, trigram FTS and time filters see the active branch's persisted text but not hidden material", async () => {
	const join = await queryBranchMessages(manager, "SELECT m.id, p.kind, substr(p.text, instr(p.text, 'targetneedle'), 12) AS hit FROM messages m JOIN parts p ON p.message_id=m.id WHERE m.timestamp >= '2026-09-30T12:01:00Z' AND m.timestamp < '2026-09-30T12:02:00Z'");
	expect(join).toEqual({ columns: ["id", "kind", "hit"], rows: [["tool", "toolCall", "targetneedle"]], truncated: false, leafId: "thought" });
	const fts = await queryBranchMessages(manager, "SELECT p.message_id FROM parts_fts JOIN parts p ON p.rowid=parts_fts.rowid WHERE parts_fts MATCH 'rollback'");
	expect(fts.rows).toEqual([["output"]]);
	const full = await queryBranchMessages(manager, "SELECT instr(text,'targetneedle') > 2000 FROM parts WHERE message_id='tool'");
	expect(full.rows).toEqual([[1]]);
	const hidden = await queryBranchMessages(manager, "SELECT count(*) FROM parts WHERE text LIKE '%secret%'");
	expect(hidden.rows).toEqual([[0]]);
});

test("malicious SQL cannot attach, inspect schema, mutate, call file-loading functions or chain statements", async () => {
	for (const sql of [
		"ATTACH DATABASE '/tmp/private.sqlite' AS hidden", "PRAGMA database_list", "PRAGMA data_version",
		"SELECT name FROM sqlite_master",
		"SELECT load_extension('/tmp/private.so')", "DELETE FROM messages", "CREATE TABLE secret(x)",
		"SELECT 1; SELECT 2", "SELECT readfile('/etc/passwd')", "SELECT randomblob(1000000)",
	]) await expect(queryBranchMessages(manager, sql)).rejects.toThrow("invalid SQL:");
	const quoted = await queryBranchMessages(manager, "SELECT ';' AS punctuation FROM messages LIMIT 1;");
	expect(quoted.rows).toEqual([[";"]]);
});

test("long-running SQL is killed independently; snippets, row counts and response bytes are bounded", async () => {
	await expect(queryBranchMessages(manager, "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n) SELECT max(i) FROM n")).rejects.toThrow("query timeout");
	const lots = { getLeafId: () => "last", getBranch: () => Array.from({ length: 70 }, (_, i) => ({
		id: `id-${i}`, parentId: i ? `id-${i - 1}` : null, timestamp: time,
		type: "message", message: { role: "user", content: "X".repeat(20_000) },
	})) };
	const rows = await queryBranchMessages(lots, "SELECT id FROM messages ORDER BY seq");
	expect(rows.rows).toHaveLength(50);
	expect(rows.truncated).toBe(true);
	const snippet = await queryBranchMessages(lots, "SELECT text FROM parts ORDER BY message_id");
	expect((snippet.rows[0]?.[0] as string).length).toBe(2000);
	expect(snippet.truncated).toBe(true);
	expect(JSON.stringify(snippet).length).toBeLessThan(65_536);
}, 15_000);
