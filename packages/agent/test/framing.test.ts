/**
 * IPC framing contract (docs/protocol.md §4): a session host that fails before
 * `ready` must report a single JSON `{t:"error"}` frame on stdout and exit
 * non-zero — and stdout must carry nothing but JSON frames.
 */

import { expect, test } from "bun:test";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

test("session host reports a fatal config error as one JSONL error frame and exits non-zero", async () => {
	const config = JSON.stringify({
		id: "s_framing0001",
		cwd: "/nonexistent-omp-hub-agent-cwd",
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "http://127.0.0.1:1",
	});
	const child = Bun.spawn([process.execPath, HOST_ENTRY, "--config", config], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: import.meta.dir,
	});

	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const exitCode = await child.exited;

	const lines = stdout.split("\n").filter(line => line.trim().length > 0);
	expect(lines).toHaveLength(1);
	expect(lines.every(line => line.startsWith("{"))).toBe(true);

	const frames = lines.map(line => JSON.parse(line) as { t?: string; message?: string });
	expect(frames[0]?.t).toBe("error");
	expect(frames[0]?.message).toContain("/nonexistent-omp-hub-agent-cwd");
	expect(exitCode).not.toBe(0);
	// Diagnostics belong on stderr; stdout is the frame channel only.
	expect(stderr).toContain("session-host fatal");
});
