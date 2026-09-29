/**
 * Remembered model presets for the model picker's quick-switch row: every
 * model the user switched to (plus the thinking level chosen with it, `""` =
 * the model's default) lands here most-recently-used first. Per-browser
 * localStorage like the hidden-session set — the hub registry is shared by
 * every guest, so remembering must stay client-side. Unknown `provider/id`
 * pairs (a model another machine offers) simply never render in pickers that
 * resolve against a different model list.
 */
import { useSyncExternalStore } from "react";

const KEY = "omp-hub.model-presets";
/** MRU cap: the quick-switch row stays scannable. */
const MAX_PRESETS = 8;

/** One remembered selection. `level === ""` means the model's default effort. */
export interface ModelPreset {
	provider: string;
	modelId: string;
	/** Thinking level applied with the switch; `""` = default. */
	level: string;
	/** Epoch ms of the last selection; the MRU sort key. */
	usedAt: number;
}

function isPreset(value: unknown): value is ModelPreset {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry["provider"] === "string" &&
		entry["provider"] !== "" &&
		typeof entry["modelId"] === "string" &&
		entry["modelId"] !== "" &&
		typeof entry["level"] === "string" &&
		typeof entry["usedAt"] === "number" &&
		Number.isFinite(entry["usedAt"])
	);
}

/** Tolerant parser: anything but a JSON array of well-formed presets reads as empty. */
export function parseStoredPresets(raw: string | null): ModelPreset[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isPreset);
	} catch {
		return [];
	}
}

let presets: readonly ModelPreset[] = load();
let snapshot: readonly ModelPreset[] = presets;
const listeners = new Set<() => void>();

function load(): readonly ModelPreset[] {
	try {
		return parseStoredPresets(globalThis.localStorage?.getItem(KEY) ?? null);
	} catch {
		return [];
	}
}

function persist(): void {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(presets));
	} catch {
		// Private mode / quota: presets still work for this page load.
	}
}

function emit(): void {
	snapshot = presets;
	for (const listener of listeners) listener();
}

function replace(next: readonly ModelPreset[]): void {
	presets = next;
	persist();
	emit();
}

/**
 * Record a selection: the entry moves to the front with the new level, a new
 * entry is prepended, and the list is capped at {@link MAX_PRESETS}.
 * Blank `provider`/`modelId` is ignored.
 */
export function rememberModelPreset(provider: string, modelId: string, level: string): void {
	const nextProvider = provider.trim();
	const nextModelId = modelId.trim();
	if (!nextProvider || !nextModelId) return;
	const entry: ModelPreset = { provider: nextProvider, modelId: nextModelId, level, usedAt: Date.now() };
	replace([entry, ...presets.filter(p => p.provider !== nextProvider || p.modelId !== nextModelId)].slice(0, MAX_PRESETS));
}

/** Reactive MRU view shared by every picker consumer. */
export function useModelPresets(): readonly ModelPreset[] {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}

/**
 * Join remembered presets with a concrete model list (an `AgentState.models`
 * snapshot): remembered entries the current agent cannot switch to are dropped,
 * the rest keep MRU order and dedupe to one row per `provider/id`, each paired
 * with its model for display.
 */
export function joinPresets<M extends { provider: string; id: string }>(
	stored: readonly ModelPreset[],
	models: readonly M[],
): { preset: ModelPreset; key: string; model: M }[] {
	const known = new Map(models.map(model => [`${model.provider}/${model.id}`, model]));
	const joined: { preset: ModelPreset; key: string; model: M }[] = [];
	const seen = new Set<string>();
	for (const preset of stored) {
		const key = `${preset.provider}/${preset.modelId}`;
		const model = known.get(key);
		if (!model || seen.has(key)) continue;
		seen.add(key);
		joined.push({ preset, key, model });
	}
	return joined;
}
