/**
 * `diffCompletedSessions` — the rail's local "task completed" detection: a
 * live session's mirrored `working` flag dropping without `inputRequired`
 * marks the session done; brand-new records and still-working/idle pairs
 * never mark.
 *
 * Marker store — `markCompletedSessions` / `clearCompletedSession` /
 * `pruneCompletedSessions` keep a sorted, deduped, localStorage-persisted id
 * set (in-memory mirror when storage is unavailable), so completed markers
 * survive a reload until the session is visited.
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/hub/api";
import {
	clearCompletedSession,
	completedSessionIds,
	diffCompletedSessions,
	markCompletedSessions,
	pruneCompletedSessions,
} from "../src/hub/rail-completion";

function record(overrides: Partial<SessionRecord>): SessionRecord {
	return {
		id: "ses_a",
		machineId: "m1",
		machineName: "dev-machine",
		cwd: "/home/sky/omp-hub",
		name: "auth refactor",
		namespaceId: null,
		membershipVersion: 0,
		status: "live",
		startedAt: 0,
		...overrides,
	};
}

function activity(working: boolean, inputRequired = false): SessionRecord["activity"] {
	return { working, inputRequired, updatedAt: 0 };
}

// Minimal localStorage stand-in, installed in the test module body (before any
// test runs). The store under test reads it lazily on every persist call; its
// import-time load finds no storage here and starts from the empty set.
class StubStorage {
	#entries = new Map<string, string>();
	getItem(key: string): string | null {
		return this.#entries.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.#entries.set(key, String(value));
	}
	removeItem(key: string): void {
		this.#entries.delete(key);
	}
	content(): string | undefined {
		return this.#entries.get("omp-hub.rail.completed");
	}
}

const storage = new StubStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

const WORKING = record({ activity: activity(true) });

describe("diffCompletedSessions", () => {
	test("marks a live session whose working flag drops without input", () => {
		expect(diffCompletedSessions([WORKING], [record({ activity: activity(false) })])).toEqual(["ses_a"]);
	});

	test("does not mark a stop that lands on input-required", () => {
		expect(diffCompletedSessions([WORKING], [record({ activity: activity(false, true) })])).toEqual([]);
	});

	test("does not mark a working→exited transition (status dot covers it)", () => {
		expect(diffCompletedSessions([WORKING], [record({ status: "exited" })])).toEqual([]);
	});

	test("a daemon disconnect does not mark an unfinished worker as completed", () => {
		expect(diffCompletedSessions([WORKING], [record({ unreachable: true, activity: undefined })])).toEqual([]);
	});

	test("brand-new records are baseline, not edges", () => {
		expect(diffCompletedSessions([], [record({ activity: activity(false) })])).toEqual([]);
		expect(diffCompletedSessions([], [WORKING])).toEqual([]);
	});

	test("still-working and idle→idle pairs never mark", () => {
		expect(diffCompletedSessions([WORKING], [WORKING])).toEqual([]);
		expect(diffCompletedSessions([record({})], [record({})])).toEqual([]);
	});

	test("a session whose first seen activity is idle never marks", () => {
		expect(diffCompletedSessions([record({ activity: undefined })], [record({ activity: activity(false) })])).toEqual([]);
	});
});

describe("completed marker store", () => {
	test("marks, dedupes, and persists sorted ids", () => {
		pruneCompletedSessions([]);
		markCompletedSessions(["ses_b", "ses_a"]);
		markCompletedSessions(["ses_b"]);
		expect(completedSessionIds()).toEqual(["ses_a", "ses_b"]);
		expect(JSON.parse(storage.content()!)).toEqual(["ses_a", "ses_b"]);
	});

	test("clearing a marker is the visit: id drops locally and from storage", () => {
		clearCompletedSession("ses_a");
		expect(completedSessionIds()).toEqual(["ses_b"]);
		expect(JSON.parse(storage.content()!)).toEqual(["ses_b"]);
	});

	test("clearing an unmarked id is a no-op", () => {
		clearCompletedSession("ses_z");
		expect(completedSessionIds()).toEqual(["ses_b"]);
	});

	test("pruning keeps only the given live ids (exited/pruned sessions drop)", () => {
		markCompletedSessions(["ses_old"]);
		pruneCompletedSessions(["ses_b"]);
		expect(completedSessionIds()).toEqual(["ses_b"]);
		expect(JSON.parse(storage.content()!)).toEqual(["ses_b"]);
	});

	test("storage failures degrade to the in-memory set", () => {
		const breaking = new Proxy(storage, {
			get(target, key) {
				if (key === "setItem" || key === "removeItem") {
					return () => {
						throw new Error("quota");
					};
				}
				return Reflect.get(target, key);
			},
		}) as StubStorage;
		(globalThis as { localStorage?: unknown }).localStorage = breaking;
		markCompletedSessions(["ses_c"]);
		expect(completedSessionIds()).toEqual(["ses_b", "ses_c"]);
		(globalThis as { localStorage?: unknown }).localStorage = storage;
		clearCompletedSession("ses_c");
		expect(completedSessionIds()).toEqual(["ses_b"]);
	});
});
