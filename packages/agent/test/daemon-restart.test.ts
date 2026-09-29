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

	test("restartSpawnArgv keeps the script in source mode", () => {
		const spawned = restartSpawnArgv(["/home/me/.local/bin/bun", "/srv/omp/packages/agent/src/main.ts", "--hub", "ws://h"]);
		expect(spawned[0]).toBe(process.execPath);
		expect(spawned.slice(1)).toEqual(["/srv/omp/packages/agent/src/main.ts", "--hub", "ws://h"]);
	});

	test("restartSpawnArgv drops the virtual entry in compiled mode", () => {
		const spawned = restartSpawnArgv(["bun", "/$bunfs/root/omp-daemon", "--hub", "ws://h"]);
		expect(spawned[0]).toBe(process.execPath);
		expect(spawned).not.toContain("/$bunfs/root/omp-daemon");
		expect(spawned.slice(1)).toEqual(["--hub", "ws://h"]);
	});
});
