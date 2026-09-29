/**
 * `model-presets` — the per-browser remembered-model store behind the picker's
 * quick-switch chips: `parseStoredPresets` tolerates corrupt storage,
 * `rememberModelPreset` keeps an MRU-ordered deduped list capped at 8 entries
 * and persists it, and `joinPresets` pairs stored entries with an available
 * model list (dropping models the current agent cannot switch to). The module
 * store loads once at import (like `hidden-sessions`), so the lifecycle below
 * runs as one flow against the empty start a fresh page gets.
 */
import { describe, expect, test } from "bun:test";
import type { ModelPreset } from "../src/hub/model-presets";
import { joinPresets, parseStoredPresets, rememberModelPreset } from "../src/hub/model-presets";

// Installed before any remember call; module-level load() already ran against
// an absent localStorage, which is the same empty start a fresh page gets.
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

const KEY = "omp-hub.model-presets";

describe("model presets", () => {
	test("parseStoredPresets tolerates corrupt payloads", () => {
		expect(parseStoredPresets(null)).toEqual([]);
		expect(parseStoredPresets("not json")).toEqual([]);
		expect(parseStoredPresets("42")).toEqual([]);
		expect(parseStoredPresets('{"provider":"x"}')).toEqual([]);
		// Malformed members drop; well-formed ones survive.
		expect(parseStoredPresets('[{"provider":"p","modelId":"m","level":"","usedAt":1},"junk",null]')).toEqual([
			{ provider: "p", modelId: "m", level: "", usedAt: 1 },
		]);
	});

	test("rememberModelPreset persists MRU-first, dedupes, caps at 8", () => {
		// The module store started empty (no localStorage at import time).
		rememberModelPreset("p1", "m1", "high");
		rememberModelPreset("p2", "m2", "");
		expect(JSON.parse(backing.get(KEY)!)).toEqual([
			{ provider: "p2", modelId: "m2", level: "", usedAt: expect.any(Number) },
			{ provider: "p1", modelId: "m1", level: "high", usedAt: expect.any(Number) },
		]);

		// Re-remembering moves the entry to the front and updates the level.
		rememberModelPreset("p1", "m1", "off");
		expect((JSON.parse(backing.get(KEY)!) as ModelPreset[]).slice(0, 2)).toEqual([
			{ provider: "p1", modelId: "m1", level: "off", usedAt: expect.any(Number) },
			{ provider: "p2", modelId: "m2", level: "", usedAt: expect.any(Number) },
		]);

		// Oldest entries drop once the MRU cap is hit.
		for (let i = 0; i < 7; i++) rememberModelPreset(`q${i}`, `n${i}`, "");
		const stored: { provider: string }[] = JSON.parse(backing.get(KEY)!);
		expect(stored).toHaveLength(8);
		expect(stored[0]).toMatchObject({ provider: "q6" });
		expect(stored.map(entry => entry.provider)).not.toContain("p2");

		// Blank identities are ignored: storage stays at the capped 8.
		rememberModelPreset("  ", "m", "");
		rememberModelPreset("p", "  ", "");
		expect(JSON.parse(backing.get(KEY)!)).toHaveLength(8);
	});

	test("joinPresets filters to available models, dedupes, keeps MRU order", () => {
		const stored = parseStoredPresets(
			JSON.stringify([
				{ provider: "gone", modelId: "x", level: "", usedAt: 3 },
				{ provider: "p", modelId: "m2", level: "high", usedAt: 2 },
				{ provider: "p", modelId: "m1", level: "", usedAt: 1 },
				{ provider: "p", modelId: "m2", level: "off", usedAt: 0 },
			]),
		);
		const models = [
			{ provider: "p", id: "m1", name: "One" },
			{ provider: "p", id: "m2", name: "Two" },
		];
		expect(joinPresets(stored, models)).toEqual([
			{ preset: { provider: "p", modelId: "m2", level: "high", usedAt: 2 }, key: "p/m2", model: models[1] },
			{ preset: { provider: "p", modelId: "m1", level: "", usedAt: 1 }, key: "p/m1", model: models[0] },
		]);
		// Nothing remembered joins to nothing.
		expect(joinPresets([], models)).toEqual([]);
	});
});
