/**
 * Supervisor test fixture (docs/protocol.md §4): a self-contained JSONL child.
 *
 * Reports `ready` on start, echoes every `cmd` back as `{ok:true,data:{echo}}`,
 * exits on `{t:"stop"}` / stdin EOF like the real session host, and exits
 * WITHOUT answering `cmd:"die"` so tests can observe pending-request rejection.
 * Deliberately imports nothing from src/ — the supervisor spawns it as a process.
 */

const decoder = new TextDecoder();
let buffer = "";

function write(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function handleLine(line: string): void {
	const frame = JSON.parse(line) as {
		t?: string;
		reqId?: string;
		cmd?: string;
		provider?: string;
		modelId?: string;
		role?: string;
		persist?: boolean;
		level?: string;
	};
	if (frame.t === "stop") {
		process.exit(0);
	}
	if (frame.t !== "cmd") return;
	if (frame.cmd === "die") {
		// Vanish mid-request: the parent must reject the pending cmd.
		process.exit(0);
	}
	write({
		t: "cmd-result",
		reqId: frame.reqId,
		ok: true,
		data: { echo: frame.cmd, got: frame },
	});
}

process.stdin.on("data", (chunk: Uint8Array | string) => {
	buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) handleLine(line);
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));

write({
	t: "ready",
	sessionFile: "fixture-session.jsonl",
	pid: process.pid,
	links: { full: "full-link", view: "view-link", web: "web-link", webView: "web-view-link" },
});
