/**
 * `historyStatus` — the home History card's agent badge: joins a row's omp
 * session file against the polled hub registry (same machine, live only),
 * `input` outranks `working`, and absent activity (older agents) reads idle.
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/hub/api";
import { historyStatus } from "../src/hub/history-status";

function record(overrides: Partial<SessionRecord>): SessionRecord {
	return {
		id: "s_a",
		machineId: "m1",
		machineName: "dev-machine",
		cwd: "/home/sky/proj",
		name: "auth refactor",
		status: "live",
		startedAt: 0,
		...overrides,
	};
}

const ENTRY = { path: "/home/sky/proj/.omp/sessions/abc.jsonl" };

describe("historyStatus", () => {
	test("returns null when no live session holds the file", () => {
		expect(historyStatus(ENTRY, "m1", [])).toBeNull();
		expect(
			historyStatus(ENTRY, "m1", [record({ sessionFile: ENTRY.path, status: "exited" })]),
		).toBeNull();
	});

	test("scopes the join to the machine and exact session file", () => {
		const sessions = [
			record({ id: "s_other_machine", machineId: "m2", sessionFile: ENTRY.path }),
			record({ id: "s_other_file", sessionFile: "/tmp/other.jsonl" }),
			record({ id: "s_match", sessionFile: ENTRY.path }),
		];
		expect(historyStatus(ENTRY, "m1", sessions)).toEqual({ sessionId: "s_match", kind: "idle" });
	});

	test("input outranks working", () => {
		const sessions = [
			record({
				sessionFile: ENTRY.path,
				activity: { working: true, inputRequired: true, updatedAt: 0 },
			}),
		];
		expect(historyStatus(ENTRY, "m1", sessions)).toEqual({ sessionId: "s_a", kind: "input" });
	});

	test("activity picks working; absent activity (older agents) reads idle", () => {
		const working = [
			record({ sessionFile: ENTRY.path, activity: { working: true, inputRequired: false, updatedAt: 0 } }),
		];
		expect(historyStatus(ENTRY, "m1", working)).toEqual({ sessionId: "s_a", kind: "working" });
		expect(historyStatus(ENTRY, "m1", [record({ sessionFile: ENTRY.path })])).toEqual({
			sessionId: "s_a",
			kind: "idle",
		});
	});
});
