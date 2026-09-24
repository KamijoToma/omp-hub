/**
 * `hidden-sessions` — the per-browser hidden-session store behind the rail and
 * quick switcher: `parseStoredIds` tolerates corrupt storage, hide/show
 * persists to localStorage, and `partitionHidden` splits a filtered listing
 * while keeping order.
 */
import { describe, expect, test } from "bun:test";
import { hideSession, parseStoredIds, partitionHidden, showSession } from "../src/hub/hidden-sessions";

// Installed before any hide/show call; module-level load() already ran against
// an absent localStorage, which is the same empty-set start a fresh page gets.
const backing = new Map<string, string>();
globalThis.localStorage = {
	getItem: (key: string) => backing.get(key) ?? null,
	setItem: (key: string, value: string) => void backing.set(key, value),
	removeItem: (key: string) => void backing.delete(key),
	clear: () => backing.clear(),
	key: () => null,
	length: 0,
	// Library boundary: a minimal Storage stand-in for the two calls the store makes.
} as unknown as Storage;

const KEY = "omp-hub.hidden-sessions";

describe("hidden sessions", () => {
	test("parseStoredIds tolerates corrupt payloads", () => {
		expect(parseStoredIds(null).size).toBe(0);
		expect(parseStoredIds("not json").size).toBe(0);
		expect(parseStoredIds("42").size).toBe(0);
		expect(parseStoredIds('["a", 3, "b"]').size).toBe(2);
		expect([...parseStoredIds('["a", "b"]')]).toEqual(["a", "b"]);
	});

	test("hide/show persist to localStorage and round trip", () => {
		hideSession("s1");
		expect(JSON.parse(backing.get(KEY)!)).toEqual(["s1"]);

		// Hiding twice stays idempotent.
		hideSession("s1");
		expect(JSON.parse(backing.get(KEY)!)).toEqual(["s1"]);

		showSession("s1");
		expect(backing.get(KEY)).toBe("[]");
		// Un-hiding an unknown id is a quiet no-op.
		showSession("s_missing");
		expect(backing.get(KEY)).toBe("[]");
	});

	test("partitionHidden splits a listing while keeping order", () => {
		const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const { visible, hidden } = partitionHidden(rows, new Set(["b"]));
		expect(visible.map(row => row.id)).toEqual(["a", "c"]);
		expect(hidden.map(row => row.id)).toEqual(["b"]);
		// Nothing hidden: the split is the identity.
		const whole = partitionHidden(rows, new Set<string>());
		expect(whole.visible).toHaveLength(3);
		expect(whole.hidden).toHaveLength(0);
	});
});
