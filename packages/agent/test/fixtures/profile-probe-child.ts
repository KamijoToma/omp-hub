/**
 * Supervisor test fixture: reports the omp profile environment it was spawned
 * with (docs/protocol.md §2 `start.profile` / §5 spawn env).
 *
 * The supervisor passes the spawn config as `--config <json>`; the test passes
 * the report destination in the unused `prompt` field. The child writes
 * `{ompProfile, piProfile}` there BEFORE emitting `ready` (so the file exists
 * once `ready` resolves), then exits on `{t:"stop"}` / stdin EOF like the real
 * session host. Deliberately imports nothing from src/.
 */

const configIndex = process.argv.indexOf("--config");
const config = JSON.parse(process.argv[configIndex + 1] ?? "{}") as { prompt?: string };
const reportPath = typeof config.prompt === "string" && config.prompt ? config.prompt : undefined;

function write(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

// Profile activation is environmental: report exactly what the process saw.
if (reportPath) {
	void Bun.write(
		reportPath,
		JSON.stringify({ ompProfile: process.env.OMP_PROFILE ?? null, piProfile: process.env.PI_PROFILE ?? null }),
	).then(() => {
		write({
			t: "ready",
			sessionFile: "profile-probe.jsonl",
			pid: process.pid,
			links: { full: "full-link", view: "view-link", web: "web-link", webView: "web-view-link" },
		});
	});
} else {
	write({
		t: "ready",
		sessionFile: "profile-probe.jsonl",
		pid: process.pid,
		links: { full: "full-link", view: "view-link", web: "web-link", webView: "web-view-link" },
	});
}

const decoder = new TextDecoder();
let buffer = "";
process.stdin.on("data", (chunk: Uint8Array | string) => {
	buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) {
			const frame = JSON.parse(line) as { t?: string };
			if (frame.t === "stop") process.exit(0);
		}
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));

// Module scope: without an export this file is a global script and tsc collides
// its helpers with the other fixture children in this directory.
export {};
