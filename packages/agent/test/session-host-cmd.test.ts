/**
 * Supervisor ⇄ session-host command channel (docs/protocol.md §4).
 *
 * The real session host needs a relay and the full SDK, so the framing under
 * test (parent side: write, correlate, settle) runs against a fixture child
 * that speaks the same JSONL protocol (test/fixtures/echo-child.ts).
 */

import { expect, test } from "bun:test";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const FIXTURE = new URL("./fixtures/echo-child.ts", import.meta.url).pathname;

/** Supervisor pointed at the fixture child, plus the frames it reported. */
function fixtureSupervisor(): {
	supervisor: Supervisor;
	ready: Promise<SessionReadyPayload>;
	exitCode: Promise<number | null>;
} {
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const exitCode = Promise.withResolvers<number | null>();
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: () => {},
			onExit: (_id, code) => exitCode.resolve(code),
		},
		createLogger("cmd-test"),
		{ hostEntry: FIXTURE },
	);
	return { supervisor, ready: ready.promise, exitCode: exitCode.promise };
}

test("supervisor cmd() round-trips cmd-results to the requesting child", async () => {
	const { supervisor, ready } = fixtureSupervisor();
	await supervisor.spawn({ id: "s_cmd_round", cwd: import.meta.dir, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	expect((await ready).sessionFile).toBe("fixture-session.jsonl");
	expect(supervisor.status()).toEqual([{ id: "s_cmd_round", status: "live" }]);

	const first = await supervisor.cmd("s_cmd_round", { reqId: "c_round1", cmd: "get-state" });
	expect(first).toEqual({ ok: true, data: { echo: "get-state", got: { t: "cmd", reqId: "c_round1", cmd: "get-state" } } });

	// Concurrent commands keep their own reqId → answer pairing.
	const [second, third] = await Promise.all([
		supervisor.cmd("s_cmd_round", { reqId: "c_round2", cmd: "set-thinking", level: "high" }),
		supervisor.cmd("s_cmd_round", { reqId: "c_round3", cmd: "set-model" }),
	]);
	expect(second).toEqual({
		ok: true,
		data: { echo: "set-thinking", got: { t: "cmd", reqId: "c_round2", cmd: "set-thinking", level: "high" } },
	});
	expect(third).toEqual({ ok: true, data: { echo: "set-model", got: { t: "cmd", reqId: "c_round3", cmd: "set-model" } } });

	await supervisor.stopAll("cmd test done");
});

test("supervisor cmd() forwards set-model role and persist fields intact", async () => {
	const { supervisor, ready } = fixtureSupervisor();
	await supervisor.spawn({ id: "s_cmd_roles", cwd: import.meta.dir, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	await ready;

	const roled = await supervisor.cmd("s_cmd_roles", {
		reqId: "c_role001",
		cmd: "set-model",
		provider: "openai",
		modelId: "gpt-5",
		role: "smol",
		persist: false,
	});
	expect(roled).toEqual({
		ok: true,
		data: {
			echo: "set-model",
			got: {
				t: "cmd",
				reqId: "c_role001",
				cmd: "set-model",
				provider: "openai",
				modelId: "gpt-5",
				role: "smol",
				persist: false,
			},
		},
	});

	// `level` rides the same frame: the model switch can preset thinking.
	const leveled = await supervisor.cmd("s_cmd_roles", {
		reqId: "c_role003",
		cmd: "set-model",
		provider: "openai",
		modelId: "gpt-5",
		level: "xhigh",
	});
	expect(leveled).toEqual({
		ok: true,
		data: {
			echo: "set-model",
			got: {
				t: "cmd",
				reqId: "c_role003",
				cmd: "set-model",
				provider: "openai",
				modelId: "gpt-5",
				level: "xhigh",
			},
		},
	});

	// Omitted fields stay absent so children see an unchanged frame.
	const plain = await supervisor.cmd("s_cmd_roles", { reqId: "c_role002", cmd: "set-model" });
	expect(plain).toEqual({ ok: true, data: { echo: "set-model", got: { t: "cmd", reqId: "c_role002", cmd: "set-model" } } });

	await supervisor.stopAll("cmd role test done");
});

test("supervisor cmd() forwards unknown parameters so new commands need no plumbing", async () => {
	const { supervisor, ready } = fixtureSupervisor();
	await supervisor.spawn({ id: "s_cmd_pass", cwd: import.meta.dir, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	await ready;

	const result = await supervisor.cmd("s_cmd_pass", {
		reqId: "c_pass001",
		cmd: "navigate-tree",
		entryId: "e_123",
		summarize: true,
		brandNew: { nested: true },
	});
	expect(result).toEqual({
		ok: true,
		data: {
			echo: "navigate-tree",
			got: {
				t: "cmd",
				reqId: "c_pass001",
				cmd: "navigate-tree",
				entryId: "e_123",
				summarize: true,
				brandNew: { nested: true },
			},
		},
	});

	await supervisor.stopAll("cmd pass-through test done");
});

test("supervisor cmd() fails unknown sessions instead of hanging", async () => {
	const { supervisor } = fixtureSupervisor();
	expect(await supervisor.cmd("s_cmd_missing", { reqId: "c_missing", cmd: "get-state" })).toEqual({
		ok: false,
		error: "unknown session",
	});
});

test("supervisor cmd() rejects pending commands when the child exits", async () => {
	const { supervisor, ready, exitCode } = fixtureSupervisor();
	await supervisor.spawn({ id: "s_cmd_dying", cwd: import.meta.dir, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	await ready;

	// The fixture exits without answering `die`; the caller must not hang.
	const pending = supervisor.cmd("s_cmd_dying", { reqId: "c_die1", cmd: "die" });
	await expect(pending).rejects.toThrow("s_cmd_dying");
	expect(await exitCode).toBe(0);
	expect(supervisor.status()).toEqual([]);
});

test("supervisor refuses a second live session on the same session file", async () => {
	const errors: Array<{ id: string; error: string }> = [];
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (id, error) => errors.push({ id, error }),
			onExit: () => {},
		},
		createLogger("guard-test"),
		{ hostEntry: FIXTURE },
	);

	const file = "/tmp/omp-hub-guard-test/session.jsonl";
	await supervisor.spawn({ id: "s_guard_first", cwd: import.meta.dir, sessionFile: file, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	await ready.promise;

	// Same file under an aliased spelling must still be recognized.
	await supervisor.spawn({
		id: "s_guard_second",
		cwd: import.meta.dir,
		sessionFile: "/tmp/omp-hub-guard-test/../omp-hub-guard-test/session.jsonl",
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	expect(errors).toEqual([
		{
			id: "s_guard_second",
			error: `session file already in use by session s_guard_first: /tmp/omp-hub-guard-test/session.jsonl`,
		},
	]);
	expect(supervisor.status()).toEqual([{ id: "s_guard_first", status: "live" }]);

	// The guard releases once the holder exits: a fresh supervisor (what a
	// restarted daemon or a post-exit registry sees) can open the same file.
	await supervisor.stopAll("guard test done");
	const errors2: Array<{ id: string; error: string }> = [];
	const ready2 = Promise.withResolvers<SessionReadyPayload>();
	const supervisor2 = new Supervisor(
		{
			onReady: (_id, payload) => ready2.resolve(payload),
			onError: (id, error) => errors2.push({ id, error }),
			onExit: () => {},
		},
		createLogger("guard-test-2"),
		{ hostEntry: FIXTURE },
	);
	await supervisor2.spawn({ id: "s_guard_third", cwd: import.meta.dir, sessionFile: file, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	await ready2.promise;
	expect(errors2).toEqual([]);
	await supervisor2.stopAll("guard test 2 done");
});
