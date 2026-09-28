/**
 * Supervisor fleet test fixture (protocol 0.8.0 `fleet-req`/`fleet-res`).
 *
 * Reports `ready` on start, then on `cmd:"emit-fleet-req"` writes a raw
 * `fleet-req` frame on stdout (the parent is expected to intercept it and
 * answer `fleet-res` on stdin). The correlated `fleet-res` is forwarded back
 * as the cmd's `cmd-result` data, so the test observes exactly what the
 * parent wrote. Exits on `{t:"stop"}` / stdin EOF. Deliberately imports
 * nothing from src/.
 */

const decoder = new TextDecoder();
let buffer = "";

function write(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** fleet-req reqId -> the cmd reqId waiting for its fleet-res. */
const waiting = new Map<string, string>();

function handleLine(line: string): void {
	const frame = JSON.parse(line) as {
		t?: string;
		reqId?: string;
		cmd?: string;
		method?: string;
		path?: string;
		body?: unknown;
		ok?: boolean;
		status?: number;
		error?: string;
	};
	if (frame.t === "stop") process.exit(0);
	if (frame.t === "fleet-res") {
		// The parent's answer: forward it verbatim as the parked cmd's data.
		const cmdReqId = waiting.get(frame.reqId ?? "");
		if (cmdReqId === undefined) return;
		waiting.delete(frame.reqId ?? "");
		write({ t: "cmd-result", reqId: cmdReqId, ok: true, data: frame });
		return;
	}
	if (frame.t !== "cmd") return;
	if (frame.cmd === "emit-fleet-req") {
		const fleetReqId = `fleet_${frame.reqId}`;
		waiting.set(fleetReqId, frame.reqId ?? "");
		write({
			t: "fleet-req",
			reqId: fleetReqId,
			method: frame.method ?? "GET",
			path: frame.path ?? "/api/machines",
			...(frame.body === undefined ? {} : { body: frame.body }),
		});
		return;
	}
	write({ t: "cmd-result", reqId: frame.reqId, ok: true, data: { echo: frame.cmd } });
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

// Module scope: without an export this file is a global script and tsc collides
// its helpers with the other fixture children in this directory.
export {};

write({
	t: "ready",
	sessionFile: "fleet-fixture.jsonl",
	pid: process.pid,
	links: { full: "full-link", view: "view-link", web: "web-link", webView: "web-view-link" },
});
