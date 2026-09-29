/**
 * Resume through the real session host (docs/protocol.md §4): a `start` config
 * carrying `sessionFile` must open the existing omp session file — the ready
 * frame reports it as the session file, and commands run against the restored
 * history instead of a fresh session. The relay is an in-process WS stub: the
 * host only needs the socket to open before it reports ready.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createLogger } from "../src/log";
import { executeCommand } from "../src/session-host";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";
import { startHub } from "../../hub/src/server";

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

		// `rename` applies through the real SDK session manager: the reply
		// echoes the applied name and get-state reports it as sessionName.
		const rename = await supervisor.cmd("s_resume001", {
			reqId: "c_resume02",
			cmd: "rename",
			name: "  Renamed resume  ",
		});
		expect(rename.ok).toBe(true);
		const renameData = rename.ok ? rename.data : undefined;
		if (typeof renameData !== "object" || renameData === null || !("name" in renameData)) {
			throw new Error(`rename payload has no name: ${JSON.stringify(rename)}`);
		}
		expect(renameData.name).toBe("Renamed resume");
		const renamedState = await supervisor.cmd("s_resume001", { reqId: "c_resume03", cmd: "get-state" });
		const renamedData = renamedState.ok ? renamedState.data : undefined;
		if (typeof renamedData !== "object" || renamedData === null || !("sessionName" in renamedData)) {
			throw new Error(`get-state payload has no sessionName: ${JSON.stringify(renamedState)}`);
		}
		expect(renamedData.sessionName).toBe("Renamed resume");

		// A blank name is a cmd error, not a silent no-op.
		const blank = await supervisor.cmd("s_resume001", { reqId: "c_resume04", cmd: "rename", name: "   " });
		expect(blank).toEqual({ ok: false, error: "rename requires a non-empty name" });
	} finally {
		await supervisor.stopAll("resume test done");
		relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);

test("fleet fork clones the current branch into a separate persisted session without switching its source", async () => {
	const relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 })),
		websocket: { open() {}, message() {}, close() {} },
	});
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-fleet-fork-host-"));
	const project = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	await mkdir(project);
	await mkdir(sessionDir);
	const seed = SessionManager.create(project, sessionDir);
	const first = seed.appendMessage({ role: "user", content: "common context", timestamp: Date.now() });
	seed.appendMessage({ role: "user", content: "old branch", timestamp: Date.now() });
	seed.branch(first);
	seed.appendMessage({ role: "user", content: "active branch", timestamp: Date.now() });
	await seed.ensureOnDisk();
	await seed.flush();
	const sourceFile = seed.getSessionFile();
	if (!sourceFile) throw new Error("source session missing file");
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const supervisor = new Supervisor({
		onReady: (_id, payload) => ready.resolve(payload),
		onError: (_id, error) => ready.reject(new Error(error)),
		onExit: () => {},
	}, createLogger("fleet-fork-host-test"), { hostEntry: HOST_ENTRY });
	let forkFile: string | undefined;
	try {
		await supervisor.spawn({
			id: "s_fork_source", cwd: project, sessionFile: sourceFile,
			relayUrl: `ws://127.0.0.1:${relay.port}`, webUrl: "",
		});
		expect((await ready.promise).sessionFile).toBe(sourceFile);
		const before = await readFile(sourceFile, "utf8");
		const result = await supervisor.cmd("s_fork_source", { reqId: "c_fork", cmd: "fleet-fork-session" });
		expect(result.ok).toBe(true);
		if (!result.ok || !result.data || typeof result.data !== "object" || !("sessionFile" in result.data)) {
			throw new Error(`fork did not return sessionFile: ${JSON.stringify(result)}`);
		}
		const clonedFile = result.data.sessionFile;
		if (typeof clonedFile !== "string") throw new Error("fork sessionFile is not a string");
		forkFile = clonedFile;
		expect(clonedFile).not.toBe(sourceFile);
		expect(await readFile(sourceFile, "utf8")).toBe(before);
		const clone = await SessionManager.open(clonedFile, undefined, undefined, { throwIfMissing: true });
		const source = await SessionManager.open(sourceFile, undefined, undefined, { throwIfMissing: true });
		expect(clone.getSessionId()).not.toBe(source.getSessionId());
		expect(clone.getHeader()?.parentSession).toBe(source.getSessionId());
		expect(clone.getEntries()).toEqual(source.getEntries());
		expect(clone.getBranch().flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		)).toEqual(["common context", "active branch"]);
		expect(clone.getEntries().flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		)).toContain("old branch");
		clone.appendMessage({ role: "user", content: "fork-only turn", timestamp: Date.now() });
		await clone.flush();
		expect(await readFile(sourceFile, "utf8")).toBe(before);
		const rename = await supervisor.cmd("s_fork_source", { reqId: "c_after_fork", cmd: "rename", name: "Source is still live" });
		expect(rename.ok).toBe(true);
		expect((await SessionManager.open(clonedFile, undefined, undefined, { throwIfMissing: true })).getSessionName())
			.not.toBe("Source is still live");
	} finally {
		await supervisor.stopAll("fleet fork host test done");
		if (forkFile) await seed.dropSession(forkFile);
		relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);

test("fleet fork rejects an active or queued source before touching its persisted file", async () => {
	let flushes = 0;
	let leaf = "original";
	const state = {
		isStreaming: false,
		queuedMessageCount: 0,
		isCompacting: false,
		isGeneratingHandoff: false,
		hasPostPromptWork: false,
		sessionManager: {
			getSessionFile: () => "/unused/source.jsonl",
			getLeafId: () => leaf,
			flush: async () => { flushes++; },
		},
	};
	const fork = () => executeCommand(
		state as unknown as Parameters<typeof executeCommand>[0],
		{ t: "cmd", reqId: "c_busy", cmd: "fleet-fork-session" },
		{} as Parameters<typeof executeCommand>[2],
		{} as Parameters<typeof executeCommand>[3],
	);
	state.isStreaming = true;
	await expect(fork()).rejects.toThrow("session is busy;");
	state.isStreaming = false;
	state.queuedMessageCount = 1;
	await expect(fork()).rejects.toThrow("session is busy;");
	expect(flushes).toBe(0);
	// A turn scheduled while the persistence flush is in flight must also
	// refuse the fork; the stat and SDK copy may not run after that point.
	const flushing = Promise.withResolvers<void>();
	const enteredFlush = Promise.withResolvers<void>();
	state.queuedMessageCount = 0;
	state.sessionManager.flush = async () => {
		flushes++;
		enteredFlush.resolve();
		await flushing.promise;
	};
	const pending = fork();
	await enteredFlush.promise;
	state.queuedMessageCount = 1;
	flushing.resolve();
	await expect(pending).rejects.toThrow("session is busy;");
	expect(flushes).toBe(1);
	// A guest append during flush changes the branch even if its turn finishes
	// before the post-flush idle check. It cannot be treated as one snapshot.
	state.queuedMessageCount = 0;
	state.sessionManager.flush = async () => { leaf = "guest-append"; };
	await expect(fork()).rejects.toThrow("source session changed while forking");
});

test("fleet fork refuses a lazy source whose session file has not materialized", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-fork-lazy-"));
	try {
		const state = {
			isStreaming: false, queuedMessageCount: 0, isCompacting: false,
			isGeneratingHandoff: false, hasPostPromptWork: false,
			sessionManager: {
				getSessionFile: () => path.join(root, "not-yet-persisted.jsonl"),
				getLeafId: () => null,
				flush: async () => {},
			},
		};
		await expect(executeCommand(
			state as unknown as Parameters<typeof executeCommand>[0],
			{ t: "cmd", reqId: "c_lazy", cmd: "fleet-fork-session" },
			{} as Parameters<typeof executeCommand>[2],
			{} as Parameters<typeof executeCommand>[3],
		)).rejects.toThrow("source session is not persisted");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("hub resume reaches the daemon and reopens the saved session", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-daemon-resume-"));
	const project = path.join(root, "project");
	const sessionFile = path.join(root, "saved.jsonl");
	await mkdir(project);
	await writeFile(
		sessionFile,
		[
			JSON.stringify({ type: "session", version: 3, id: "savedresume01", timestamp: "2026-06-27T00:00:00.000Z", cwd: project }),
			JSON.stringify({ type: "message", message: { role: "user", content: "saved prompt" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "saved response" } }),
		].join("\n") + "\n",
	);

	const hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	const daemon = Bun.spawn(
		[process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "--hub", hub.url, "--machine-id", "m_daemon_resume"],
		{
			cwd: import.meta.dir,
			env: { ...process.env, HOME: root, HUB_TOKEN: "t", PI_CONFIG_DIR: "", OMP_PROFILE: "", PI_PROFILE: "" },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	const headers = { authorization: "Bearer t" };
	const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>): Promise<T> => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const result = await probe();
			if (result !== undefined) return result;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	};

	try {
		await waitFor("machine registration", async () => {
			const response = await fetch(`${hub.url}/api/machines`, { headers });
			const body = (await response.json()) as { machines: { machineId: string; connected: boolean }[] };
			return body.machines.some(machine => machine.machineId === "m_daemon_resume" && machine.connected) ? true : undefined;
		});
		const started = await fetch(`${hub.url}/api/sessions`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ machineId: "m_daemon_resume", cwd: project, sessionFile }),
		});
		expect(started.status).toBe(202);
		const { session: created } = (await started.json()) as { session: { id: string } };
		const reopened = await waitFor("resumed session", async () => {
			const response = await fetch(`${hub.url}/api/sessions/${created.id}`, { headers });
			const body = (await response.json()) as { session: { status: string; sessionFile?: string; error?: string } };
			if (body.session.status === "failed" || body.session.status === "exited") {
				throw new Error(body.session.error ?? `session ${body.session.status}`);
			}
			return body.session.status === "live" ? body.session : undefined;
		});
		expect(reopened.sessionFile).toBe(sessionFile);
	} finally {
		daemon.kill("SIGTERM");
		await daemon.exited;
		hub.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
