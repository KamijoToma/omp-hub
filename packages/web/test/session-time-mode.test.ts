/**
 * `session-time-mode` — the per-browser rail timestamp preference behind the
 * picker rows: `parseStoredMode` tolerates corrupt storage, the toggle
 * persists, and `sessionActivityTime` falls back activity → exit → start.
 */
import { describe, expect, test } from "bun:test";
import { parseStoredMode, sessionActivityTime, toggleSessionTimeMode } from "../src/hub/session-time-mode";

// Installed before any toggle; module-level load() already ran, which is the
// same default a fresh page gets.
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

const KEY = "omp-hub.session-time-mode";

describe("session time mode", () => {
	test("parseStoredMode tolerates corrupt payloads", () => {
		expect(parseStoredMode(null)).toBe("created");
		expect(parseStoredMode("created")).toBe("created");
		expect(parseStoredMode("activity")).toBe("activity");
		expect(parseStoredMode("nonsense")).toBe("created");
		expect(parseStoredMode('{"mode":"activity"}')).toBe("created");
	});

	test("toggle flips and persists for every consumer", () => {
		expect(backing.get(KEY)).toBeUndefined();
		toggleSessionTimeMode();
		expect(backing.get(KEY)).toBe("activity");
		toggleSessionTimeMode();
		expect(backing.get(KEY)).toBe("created");
	});

	test("sessionActivityTime prefers the activity mirror, then exit, then start", () => {
		expect(sessionActivityTime({ startedAt: 1000 })).toBe(1000);
		expect(sessionActivityTime({ startedAt: 1000, exitedAt: 2000 })).toBe(2000);
		expect(
			sessionActivityTime({
				startedAt: 1000,
				exitedAt: 2000,
				activity: { working: false, inputRequired: false, updatedAt: 3000 },
			}),
		).toBe(3000);
	});
});
