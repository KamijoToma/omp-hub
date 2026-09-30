import { constants } from "node:sqlite";
import { projectBranch, type SqlMessageResult, type SqlVisibleMessage } from "./sql-projection";

/** Only one SQL statement; a semicolon inside a string/comment/quoted name is not a separator. */
function singleStatement(sql: string): boolean {
	let state: "normal" | "line" | "block" | "single" | "double" | "backtick" | "bracket" = "normal";
	let ended = false;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i]!;
		const next = sql[i + 1];
		if (state === "line") { if (ch === "\n") state = "normal"; continue; }
		if (state === "block") { if (ch === "*" && next === "/") { state = "normal"; i++; } continue; }
		if (state === "bracket") { if (ch === "]") state = "normal"; continue; }
		if (state !== "normal") {
			const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
			if (ch === quote) { if (next === quote) i++; else state = "normal"; }
			continue;
		}
		if (ch === "-" && next === "-") { state = "line"; i++; continue; }
		if (ch === "/" && next === "*") { state = "block"; i++; continue; }
		if (/\s/.test(ch)) continue;
		if (ended) return false;
		if (ch === ";") { ended = true; continue; }
		if (ch === "'") state = "single";
		else if (ch === '"') state = "double";
		else if (ch === "`") state = "backtick";
		else if (ch === "[") state = "bracket";
	}
	return state === "normal" || state === "line";
}

const FUNCTIONS: Record<string, true> = {
	abs: true, avg: true, bm25: true, char: true, coalesce: true, count: true, date: true,
	datetime: true, glob: true, group_concat: true, hex: true, highlight: true, ifnull: true,
	instr: true, json: true, json_array: true, json_extract: true, json_object: true,
	julianday: true, length: true, like: true, lower: true, ltrim: true, match: true,
	max: true, min: true, nullif: true, printf: true, replace: true, round: true,
	rtrim: true, snippet: true, strftime: true, substr: true, substring: true,
	sum: true, time: true, timediff: true, total: true, trim: true, typeof: true,
	unicode: true, unixepoch: true, upper: true,
};

const ALLOWED_TABLES: Record<string, true> = {
	messages: true, parts: true, parts_fts: true, parts_fts_data: true, parts_fts_idx: true,
	parts_fts_docsize: true, parts_fts_config: true,
};

export function executeSqlProjection(sql: string, bytes: Uint8Array, leafId: string | null): SqlMessageResult {
	if (typeof sql !== "string" || !sql.trim() || sql.length > 4096 || !singleStatement(sql) ||
		!/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH)\b/i.test(sql)) {
		throw new Error("invalid SQL: expected one SELECT or WITH statement of at most 4096 characters");
	}
	const rows: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (!Array.isArray(rows)) throw new Error("invalid SQL: invalid query frame");
	const db = projectBranch(rows as SqlVisibleMessage[]);
	try {
		db.exec("PRAGMA query_only=ON");
		db.setAuthorizer((action, arg1, arg2, database) => {
			if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
			// SQLite reports dbName=null, column="" for constant SELECTs over these tables.
			if (action === constants.SQLITE_READ && ALLOWED_TABLES[arg1 ?? ""] === true &&
				(database === "main" || (database === null && (arg2 === "" || arg2 === null)))) return constants.SQLITE_OK;
			// FTS5's internal MATCH implementation asks for data_version to invalidate its index cache.
			// A direct PRAGMA has dbName=null and remains forbidden.
			if (action === constants.SQLITE_PRAGMA && arg1 === "data_version" &&
				arg2 === null && database === "main") return constants.SQLITE_OK;
			if (action === constants.SQLITE_FUNCTION && FUNCTIONS[(arg2 ?? "").toLowerCase()] === true) return constants.SQLITE_OK;
			return constants.SQLITE_DENY;
		});
		const stmt = db.prepare(sql);
		const columns = stmt.columns().map(col => col.name.slice(0, 256));
		if (!columns.length) throw new Error("invalid SQL: expected a SELECT result");
		const rows: unknown[][] = [];
		let truncated = false;
		let size = Buffer.byteLength(JSON.stringify({ columns, rows, truncated, leafId }));
		for (const raw of stmt.iterate() as unknown as Iterable<unknown[]>) {
			if (rows.length === 50) { truncated = true; break; }
			const row = raw.map(cell => {
				if (typeof cell === "string") {
					if (cell.length > 2000) truncated = true;
					return cell.slice(0, 2000);
				}
				if (typeof cell === "bigint") return cell.toString();
				if (cell instanceof Uint8Array) { truncated = true; return null; }
				return cell;
			});
			const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (size + bytes > 63 * 1024) { truncated = true; break; }
			rows.push(row);
			size += bytes;
		}
		return { columns, rows, truncated, leafId };
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("invalid SQL:")) throw err;
		// Do not relay raw SQLite errors: SQL can include file names and private values.
		throw new Error("invalid SQL: query rejected");
	} finally {
		db.close();
	}
}

/** One JSON header line followed by exactly `length` bytes of visible branch JSON. */
async function readQueryFrame(): Promise<{ sql: string; leafId: string | null; bytes: Uint8Array }> {
	const reader = Bun.stdin.stream().getReader();
	const header = new Uint8Array(8192);
	let headerLength = 0;
	let bytes: Uint8Array | undefined;
	let received = 0;
	let sql = "";
	let leafId: string | null = null;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		let offset = 0;
		if (!bytes) {
			const newline = value.indexOf(10);
			const end = newline < 0 ? value.length : newline;
			if (headerLength + end > header.length) throw new Error("invalid SQL: query header too long");
			header.set(value.subarray(0, end), headerLength);
			headerLength += end;
			if (newline < 0) continue;
			const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header.subarray(0, headerLength)));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid SQL: invalid query frame");
			const frame = parsed as Record<string, unknown>;
			if (typeof frame.sql !== "string" || !frame.sql.trim() || frame.sql.length > 4096 ||
				!Number.isSafeInteger(frame.length) || (frame.length as number) < 1 ||
				(frame.length as number) > 128 * 1024 * 1024 ||
				(frame.leafId !== null && (typeof frame.leafId !== "string" || frame.leafId.length > 256))) {
				throw new Error("invalid SQL: invalid query frame");
			}
			sql = frame.sql;
			leafId = frame.leafId as string | null;
			bytes = new Uint8Array(frame.length as number);
			offset = newline + 1;
		}
		const remaining = value.byteLength - offset;
		if (received + remaining > bytes.length) throw new Error("invalid SQL: extra query data");
		bytes.set(value.subarray(offset), received);
		received += remaining;
	}
	if (!bytes || received !== bytes.length) throw new Error("invalid SQL: incomplete query frame");
	return { sql, leafId, bytes };
}

if (import.meta.main) {
	try {
		const { sql, bytes, leafId } = await readQueryFrame();
		const result = executeSqlProjection(sql, bytes, leafId);
		process.stdout.write(JSON.stringify({ ok: true, data: result }));
	} catch (err) {
		const error = err instanceof Error &&
			(err.message.startsWith("invalid SQL:") || err.message.startsWith("session history unavailable:"))
			? err.message : "invalid SQL: query rejected";
		process.stdout.write(JSON.stringify({ ok: false, error }));
	}
}
