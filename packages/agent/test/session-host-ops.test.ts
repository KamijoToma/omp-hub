/**
 * Session-op verbs against the real session host (docs/protocol.md §2/§4):
 * `get-state` carries the extendedContext/goal/loop fields, `loop` drives the
 * host-side controller, and `set-extended-context` round-trips the session
 * setting. No model is needed — the compact/retry/goal-mutation verbs require
 * provider auth and are covered by contract tests elsewhere. The relay is an
 * in-process WS stub: the host only needs the socket to open before it
 * reports ready.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

interface CommandOutcome {
	ok: boolean;
	data?: unknown;
	error?: string;
}

test("session host answers loop, extended-context, and state ops on a live session", async () => {
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

	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-ops-host-"));
	await mkdir(path.join(root, "project"));
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const exits: string[] = [];
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => exits.push(error),
			onExit: (_id, _code, reason) => exits.push(reason),
		},
		createLogger("ops-host-test"),
		{ hostEntry: HOST_ENTRY },
	);

	try {
		await supervisor.spawn({
			id: "s_ops001",
			cwd: path.join(root, "project"),
			relayUrl: `ws://127.0.0.1:${relay.port}`,
			webUrl: "",
		});
		await ready.promise;
		expect(exits).toEqual([]);

		const cmd = (reqId: string, frame: Record<string, unknown>): Promise<CommandOutcome> =>
			supervisor.cmd("s_ops001", { reqId, cmd: "", ...frame }) as Promise<CommandOutcome>;

		// get-state: the three new fields exist with off-state defaults.
		const state = await cmd("c_ops01", { cmd: "get-state" });
		expect(state.ok).toBe(true);
		expect(state.data).toMatchObject({ extendedContext: false, goal: null, loop: null });

		// loop: enable arms the controller; status/disable round-trip.
		const enabled = await cmd("c_ops02", {
			cmd: "loop",
			action: "enable",
			prompt: "keep going",
			limit: { kind: "iterations", iterations: 3 },
		});
		expect(enabled.ok).toBe(true);
		expect(enabled.data).toEqual({
			loop: { state: "running", prompt: "keep going", limit: { kind: "iterations", iterations: 3, iterationsLeft: 3 } },
		});
		const paused = await cmd("c_ops03", { cmd: "loop", action: "pause" });
		expect(paused.data).toMatchObject({ loop: { state: "paused" } });
		const disabled = await cmd("c_ops04", { cmd: "loop", action: "disable" });
		expect(disabled.data).toEqual({ loop: null });
		const badAction = await cmd("c_ops05", { cmd: "loop", action: "explode" });
		expect(badAction.ok).toBe(false);
		expect(badAction.error).toContain("unknown loop action");

		// set-extended-context: explicit set, then toggle back off.
		const on = await cmd("c_ops06", { cmd: "set-extended-context", enabled: true });
		expect(on.data).toEqual({ extendedContext: true });
		const toggled = await cmd("c_ops07", { cmd: "set-extended-context" });
		expect(toggled.data).toEqual({ extendedContext: false });

		// goal: no goal armed — the post-op state read is null.
		const dropped = await cmd("c_ops08", { cmd: "goal", action: "drop" });
		expect(dropped.ok).toBe(true);
		expect(dropped.data).toEqual({ goal: null });

		// get-state reflects the toggled setting and the disabled loop.
		const after = await cmd("c_ops09", { cmd: "get-state" });
		expect(after.data).toMatchObject({ extendedContext: false, loop: null });
	} finally {
		await supervisor.stopAll("ops test done");
		relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
