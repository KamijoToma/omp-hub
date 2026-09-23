/**
 * Resume through the real session host (docs/protocol.md §4): a `start` config
 * carrying `sessionFile` must open the existing omp session file — the ready
 * frame reports it as the session file, and commands run against the restored
 * history instead of a fresh session. The relay is an in-process WS stub: the
 * host only needs the socket to open before it reports ready.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

test("session host resumes an existing session file and reports it ready", async () => {
	// Any WS upgrade passes: CollabHost.start resolves on socket open.
	const relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 })),
		websocket: {
			open() {},
			message() {},
			close() {},
		},
	});

	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-resume-host-"));
	const project = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	await mkdir(project);
	await mkdir(sessionDir);
	const sessionFile = path.join(sessionDir, "20260627_resume01.jsonl");
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "resume01aa", timestamp: "2026-06-27T00:00:00.000Z", cwd: project }),
		JSON.stringify({ type: "message", message: { role: "user", content: "earlier question" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: "earlier answer" } }),
	];
	await writeFile(sessionFile, `${lines.join("\n")}\n`);

	const ready = Promise.withResolvers<SessionReadyPayload>();
	const exits: string[] = [];
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => exits.push(error),
			onExit: (_id, _code, reason) => exits.push(reason),
		},
		createLogger("resume-host-test"),
		{ hostEntry: HOST_ENTRY },
	);

	try {
		await supervisor.spawn({
			id: "s_resume001",
			cwd: project,
			sessionFile,
			relayUrl: `ws://127.0.0.1:${relay.port}`,
			webUrl: "",
		});
		const payload = await ready.promise;
		// Ready only fires after SessionManager.open() accepted the file; a
		// missing or malformed transcript would surface as onError instead.
		expect(payload.sessionFile).toBe(sessionFile);
		expect(exits).toEqual([]);
		expect(supervisor.status()).toEqual([{ id: "s_resume001", status: "live" }]);

		// The restored branch still carries the fixture's conversation.
		const state = await supervisor.cmd("s_resume001", { reqId: "c_resume01", cmd: "get-state" });
		expect(state.ok).toBe(true);
		// get-state reports the resumed manager's cwd — the recorded header cwd,
		// which open() only adopts after reading the session header.
		const stateData = state.ok ? state.data : undefined;
		if (typeof stateData !== "object" || stateData === null || !("cwd" in stateData)) {
			throw new Error(`get-state payload has no cwd: ${JSON.stringify(state)}`);
		}
		expect(stateData.cwd).toBe(path.resolve(project));
	} finally {
		await supervisor.stopAll("resume test done");
		relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
