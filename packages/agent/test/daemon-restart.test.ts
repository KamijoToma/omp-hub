/**
 * Daemon upgrade restart routine (docs/protocol.md §2 `restart-daemon`):
 * ordering, replacement argv, exit, and the failure path that must leave the
 * process alive without spawning.
 */
import { describe, expect, test } from "bun:test";
import { performDaemonRestart, restartFailure, restartSpawnArgv } from "../src/daemon-restart";
import type { Logger } from "../src/log";

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("performDaemonRestart", () => {
	test("stops children, spawns the replacement from the same argv, then exits", async () => {
		const order: string[] = [];
		const spawned: string[][] = [];
		await performDaemonRestart({
			supervisor: {
				stopAll: async () => {
					order.push("stopAll");
				},
			},
			log: SILENT,
			stopDashboards: () => {
				order.push("dashboards");
			},
			spawnReplacement: argv => {
				order.push("spawn");
				spawned.push(argv);
			},
			exit: code => {
				order.push(`exit ${code}`);
			},
		});
		// Children must be fully stopped (session files released) before the
		// replacement spawns — the hub replays same-id starts on reconnect and a
		// live old child would trip the session-file-in-use guard.
		expect(order).toEqual(["stopAll", "dashboards", "spawn", "exit 0"]);
		expect(spawned[0]![0]).toBe(process.execPath);
		expect(spawned[0]![1]).toBe(process.argv[1]);
	});

	test("compiled daemon re-execs without passing its virtual entry as a CLI argument", () => {
		expect(restartSpawnArgv(["bun", "/$bunfs/root/packages/agent/src/main.js", "--hub", "wss://hub.test", "--name", "m"], true))
			.toEqual([process.execPath, "--hub", "wss://hub.test", "--name", "m"]);
		expect(restartSpawnArgv(["bun", "/repo/packages/agent/src/main.ts", "--hub", "ws://localhost"], false))
			.toEqual([process.execPath, "/repo/packages/agent/src/main.ts", "--hub", "ws://localhost"]);
	});

	test("a stop failure aborts the handover without spawning or exiting", async () => {
		let spawned = false;
		let exited = false;
		let message = "";
		try {
			await performDaemonRestart({
				supervisor: {
					stopAll: async () => {
						throw new Error("child would not stop");
					},
				},
				log: SILENT,
				stopDashboards: () => {},
				spawnReplacement: () => {
					spawned = true;
				},
				exit: () => {
					exited = true;
				},
			});
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toBe("child would not stop");
		expect(spawned).toBe(false);
		expect(exited).toBe(false);
	});

	test("restartFailure formats thrown values", () => {
		expect(restartFailure(new Error("boom"))).toBe("daemon restart failed: boom");
	});
});
