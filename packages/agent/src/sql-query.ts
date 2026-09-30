import path from "node:path";
import { isCompiledAgent } from "./native-mode";
import { selectVisibleBranch, type SqlBranchManager, type SqlMessageResult } from "./sql-projection";

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 4000;

export function sqlQueryCommand(execPath = process.execPath, compiled = isCompiledAgent): string[] {
	return compiled
		? [path.join(path.dirname(execPath), "omp-hub-agent-sql-query")]
		: [execPath, new URL("./sql-query-worker.ts", import.meta.url).pathname];
}

/** The child receives only this branch's visible text, never the source file or ambient credentials. */
export async function queryBranchMessages(manager: SqlBranchManager, sql: unknown): Promise<SqlMessageResult> {
	if (typeof sql !== "string" || !sql.trim() || sql.length > 4096) {
		throw new Error("invalid SQL: expected a nonempty query of at most 4096 characters");
	}
	const started = performance.now();
	const leafId = manager.getLeafId();
	const bytes = new TextEncoder().encode(JSON.stringify(selectVisibleBranch(manager)));
	if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("session history unavailable: projection exceeds memory budget");
	if (performance.now() - started >= QUERY_TIMEOUT_MS) throw new Error("query timeout");
	let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
	try {
		child = Bun.spawn(sqlQueryCommand(), {
			stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd: "/",
			env: { PATH: process.env.PATH ?? "", TZ: process.env.TZ ?? "UTC" },
		});
	} catch {
		throw new Error("query executor unavailable");
	}
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); },
		Math.max(0, QUERY_TIMEOUT_MS - (performance.now() - started)));
	try {
		const header = new TextEncoder().encode(`${JSON.stringify({ sql, leafId, length: bytes.byteLength })}\n`);
		if (header.length > 8192) throw new Error("invalid SQL: query header too long");
		const readOutput = (async (): Promise<string> => {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let output = "";
			let received = 0;
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > 65_536) {
					child.kill("SIGKILL");
					throw new Error("invalid SQL: output limit exceeded");
				}
				output += decoder.decode(value, { stream: true });
			}
			return output + decoder.decode();
		})();
		const send = (async () => {
			await child.stdin.write(header);
			await child.stdin.write(bytes);
			await child.stdin.flush();
			child.stdin.end();
		})();
		const [raw] = await Promise.all([readOutput, send, child.exited]);
		if (timedOut) throw new Error("query timeout");
		const reply = JSON.parse(raw) as { ok: boolean; data?: SqlMessageResult; error?: string };
		if (!reply.ok) throw new Error(reply.error ?? "invalid SQL: query rejected");
		if (!reply.data || !Array.isArray(reply.data.columns) || !Array.isArray(reply.data.rows)) {
			throw new Error("invalid SQL: malformed query result");
		}
		return reply.data;
	} catch (err) {
		if (timedOut) throw new Error("query timeout");
		if (err instanceof Error &&
			(err.message.startsWith("invalid SQL:") || err.message.startsWith("session history unavailable:"))) throw err;
		throw new Error("query executor unavailable");
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}
