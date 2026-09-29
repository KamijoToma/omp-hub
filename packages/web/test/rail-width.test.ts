/**
 * `rail-width` — the per-browser rail width preference behind the edge drag
 * handle: `clampRailWidth` bounds junk/dragged/stored pixels per rail state,
 * and `setRailWidth` persists each state independently (the collapsed strip
 * and the expanded picker keep separate widths under separate keys).
 */
import { describe, expect, test } from "bun:test";
import { RAIL_WIDTH_BOUNDS, clampRailWidth, setRailWidth } from "../src/hub/rail-width";

// Installed after the module-level load() ran — the same defaults a fresh
// page gets — mirroring the `session-time-mode` test's Storage stand-in.
const backing = new Map<string, string>();
globalThis.localStorage = {
	getItem: (key: string) => backing.get(key) ?? null,
	setItem: (key: string, value: string) => void backing.set(key, value),
	removeItem: (key: string) => void backing.delete(key),
	clear: () => backing.clear(),
	key: () => null,
	length: 0,
} as unknown as Storage;

describe("clampRailWidth", () => {
	test("junk pixels read as the state's fallback", () => {
		for (const state of ["collapsed", "expanded"] as const) {
			expect(clampRailWidth(state, Number.NaN)).toBe(RAIL_WIDTH_BOUNDS[state].fallback);
			expect(clampRailWidth(state, Number.POSITIVE_INFINITY)).toBe(RAIL_WIDTH_BOUNDS[state].fallback);
		}
	});

	test("drags clamp into the state's bounds and round to whole pixels", () => {
		expect(clampRailWidth("expanded", 100)).toBe(RAIL_WIDTH_BOUNDS.expanded.min);
		expect(clampRailWidth("expanded", 4096)).toBe(RAIL_WIDTH_BOUNDS.expanded.max);
		expect(clampRailWidth("expanded", 300.6)).toBe(301);
		expect(clampRailWidth("collapsed", 10)).toBe(RAIL_WIDTH_BOUNDS.collapsed.min);
		expect(clampRailWidth("collapsed", 999)).toBe(RAIL_WIDTH_BOUNDS.collapsed.max);
		expect(clampRailWidth("collapsed", 50.4)).toBe(50);
	});
});

describe("setRailWidth", () => {
	test("persists each rail state under its own key", () => {
		setRailWidth("expanded", 360);
		setRailWidth("collapsed", 64);
		expect(backing.get("omp-hub.rail.width")).toBe("360");
		expect(backing.get("omp-hub.rail.strip-width")).toBe("64");
	});

	test("clamps before persisting", () => {
		setRailWidth("expanded", 100000);
		expect(backing.get("omp-hub.rail.width")).toBe(String(RAIL_WIDTH_BOUNDS.expanded.max));
	});
});
