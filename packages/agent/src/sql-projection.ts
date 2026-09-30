import { DatabaseSync } from "node:sqlite";
import type { FleetBranchManager } from "./fleet-client";

const MAX_VISIBLE_CHARS = 48 * 1024 * 1024;
const MAX_VISIBLE_MESSAGES = 200_000;

export interface SqlVisibleMessage {
	id: string;
	timestamp: string;
	role: string;
	toolName: string | null;
	parts: Array<{ kind: string; text: string }>;
}

/** Copy only visible text and tool arguments out of the active branch; never transport hidden or binary blocks. */
export function selectVisibleBranch(manager: FleetBranchManager): SqlVisibleMessage[] {
	const rows: SqlVisibleMessage[] = [];
	let visibleChars = 0;
	for (const entry of manager.getBranch()) {
		if (entry.type !== "message" && (entry.type !== "custom_message" || entry.display === false)) continue;
		visibleChars += entry.id.length + entry.timestamp.length;
		if (rows.length >= MAX_VISIBLE_MESSAGES || visibleChars > MAX_VISIBLE_CHARS) {
			throw new Error("session history unavailable: projection exceeds memory budget");
		}
		const message = entry.message;
		const role = entry.type === "custom_message" ? "custom" : message?.role ?? "unknown";
		const row: SqlVisibleMessage = {
			id: entry.id, timestamp: entry.timestamp, role, toolName: message?.toolName ?? null, parts: [],
		};
		rows.push(row);
		const content = entry.type === "custom_message" ? entry.content : message?.content;
		const add = (kind: string, text: string): void => {
			visibleChars += text.length;
			if (visibleChars > MAX_VISIBLE_CHARS) {
				throw new Error("session history unavailable: projection exceeds memory budget");
			}
			row.parts.push({ kind, text });
		};
		if (typeof content === "string") add(role === "custom" ? "custom" : "text", content);
		else if (Array.isArray(content)) for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if (part.type === "text" && typeof part.text === "string") add(role === "toolResult" ? "toolResult" : "text", part.text);
			else if (part.type === "toolCall" && part.arguments !== undefined) {
				const args = JSON.stringify(part.arguments);
				if (typeof args === "string") add("toolCall", args);
			}
		}
	}
	return rows;
}

/** FTS indexing runs only in the disposable child, never on the session host's event loop. */
export function projectBranch(rows: readonly SqlVisibleMessage[]): DatabaseSync {
	const db = new DatabaseSync(":memory:", {
		allowExtension: false, defensive: true, returnArrays: true,
		limits: { attach: 0, sqlLength: 4096, column: 32, exprDepth: 64, compoundSelect: 32,
			vdbeOp: 100_000, length: 64 * 1024 * 1024, likePatternLength: 4096 },
	});
	try {
		db.exec("PRAGMA temp_store=MEMORY");
		// FTS construction and later recursive SQL use SQLite's allocator. Each child
		// has its own process-global heap cap; fail closed if Bun ignores this pragma.
		const heapLimit = 256 * 1024 * 1024;
		const actual: unknown = db.prepare(`PRAGMA hard_heap_limit=${heapLimit}`).get();
		if (!Array.isArray(actual) || actual[0] !== heapLimit) throw new Error("query executor unavailable: SQLite heap limit");
		db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY, parent_id TEXT, seq INTEGER, timestamp TEXT, role TEXT, tool_name TEXT); CREATE TABLE parts(message_id TEXT, part_index INTEGER, kind TEXT, text TEXT)");
		// External-content trigrams support substring searches of at least three characters.
		db.exec("CREATE VIRTUAL TABLE parts_fts USING fts5(text, content='parts', content_rowid='rowid', tokenize='trigram')");
		const messageInsert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)");
		const partInsert = db.prepare("INSERT INTO parts VALUES (?, ?, ?, ?)");
		const ftsInsert = db.prepare("INSERT INTO parts_fts(rowid, text) VALUES (last_insert_rowid(), ?)");
		let previousVisibleId: string | null = null;
		for (let seq = 0; seq < rows.length; seq++) {
			const row = rows[seq]!;
			messageInsert.run(row.id, previousVisibleId, seq, row.timestamp, row.role, row.toolName);
			previousVisibleId = row.id;
			for (let index = 0; index < row.parts.length; index++) {
				const part = row.parts[index]!;
				partInsert.run(row.id, index, part.kind, part.text);
				ftsInsert.run(part.text);
			}
		}
		return db;
	} catch (err) {
		db.close();
		if (err instanceof Error && /out of memory|SQLITE_NOMEM/i.test(err.message)) {
			throw new Error("session history unavailable: projection exceeds memory budget");
		}
		throw err;
	}
}

export type SqlMessageResult = { columns: string[]; rows: unknown[][]; truncated: boolean; leafId: string | null };
export type SqlBranchManager = Pick<FleetBranchManager, "getBranch" | "getLeafId">;
