/**
 * `rail-filter` — the per-browser ended-session fold behind the rail and
 * quick switcher: the toggle persists to localStorage, `isEndedStatus`
 * classifies terminal records, and `partitionEnded` splits a filtered
 * listing while keeping order.
 */
import { describe, expect, test } from "bun:test";
import { isEndedStatus, partitionEnded, setShowEnded } from "../src/hub/rail-filter";
import type { SessionStatus } from "../src/hub/api";

// Installed after the module-level load() ran against an absent localStorage —
// the same fold-closed start a fresh page gets.
const backing = new Map<string, string>();
globalThis.localStorage = {
	getItem: (key: string) => backing.get(key) ?? null,
	setItem: (key: string, value: string) => void backing.set(key, value),
	removeItem: (key: string) => void backing.delete(key),
	clear: () => backing.clear(),
	key: () => null,
	length: 0,
	// Library boundary: a minimal Storage stand-in for the one call the store makes.
} as unknown as Storage;

const KEY = "omp-hub.rail.show-ended";

const row = (id: string, status: SessionStatus): { id: string; status: SessionStatus } => ({ id, status });

describe("rail filter", () => {
	test("ended covers exited and failed, nothing else", () => {
		expect(isEndedStatus("exited")).toBe(true);
		expect(isEndedStatus("failed")).toBe(true);
		expect(isEndedStatus("live")).toBe(false);
		expect(isEndedStatus("starting")).toBe(false);
	});

	test("the fold toggle persists to localStorage", () => {
		setShowEnded(true);
		expect(backing.get(KEY)).toBe("1");

		// Idempotent writes.
		setShowEnded(true);
		expect(backing.get(KEY)).toBe("1");

		setShowEnded(false);
		expect(backing.get(KEY)).toBe("0");
	});

	test("partitionEnded splits a listing while keeping order", () => {
		const rows = [row("a", "live"), row("b", "exited"), row("c", "starting"), row("d", "failed")];
		const { active, ended } = partitionEnded(rows);
		expect(active.map(item => item.id)).toEqual(["a", "c"]);
		expect(ended.map(item => item.id)).toEqual(["b", "d"]);
		// Nothing terminal: the split is the identity.
		const whole = partitionEnded([row("x", "live")]);
		expect(whole.active).toHaveLength(1);
		expect(whole.ended).toHaveLength(0);
	});
});
