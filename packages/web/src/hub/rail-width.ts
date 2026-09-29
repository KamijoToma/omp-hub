/**
 * Per-browser rail width preference behind the rail's edge drag handle: the
 * collapsed icon strip and the expanded picker each keep an independent pixel
 * width, applied inline to the rail aside. Stored in localStorage — same
 * constraint as `session-time-mode.ts`: the hub registry is in-memory and
 * shared by every guest, so the preference must not live server-side. One
 * store drives every consumer, so mid-drag updates re-render in lockstep.
 */
import { useSyncExternalStore } from "react";

export type RailState = "collapsed" | "expanded";

/** Per-state fallback and drag clamp bounds, in CSS pixels. */
export interface RailWidthBounds {
	readonly fallback: number;
	readonly min: number;
	readonly max: number;
}

export const RAIL_WIDTH_BOUNDS: Record<RailState, RailWidthBounds> = {
	collapsed: { fallback: 44, min: 36, max: 96 },
	expanded: { fallback: 280, min: 220, max: 560 },
};

const STORAGE_KEY: Record<RailState, string> = {
	collapsed: "omp-hub.rail.strip-width",
	expanded: "omp-hub.rail.width",
};

interface RailWidths {
	readonly collapsed: number;
	readonly expanded: number;
}

/** Clamp a dragged or stored width into the state's bounds; junk reads as the fallback. */
export function clampRailWidth(state: RailState, px: number): number {
	const { fallback, min, max } = RAIL_WIDTH_BOUNDS[state];
	if (!Number.isFinite(px)) return fallback;
	return Math.min(max, Math.max(min, Math.round(px)));
}

function loadWidth(state: RailState): number {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY[state]);
		return clampRailWidth(state, raw === null ? Number.NaN : Number(raw));
	} catch {
		return RAIL_WIDTH_BOUNDS[state].fallback;
	}
}

let widths: RailWidths = { collapsed: loadWidth("collapsed"), expanded: loadWidth("expanded") };
let snapshot = widths;
const listeners = new Set<() => void>();

function emit(): void {
	snapshot = widths;
	for (const listener of listeners) listener();
}

/** Set one rail state's width; clamped, persisted, and a no-op when unchanged. */
export function setRailWidth(state: RailState, px: number): void {
	const width = clampRailWidth(state, px);
	if (widths[state] === width) return;
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY[state], String(width));
	} catch {
		// Private mode / quota: the width still applies for this page load.
	}
	widths = state === "collapsed" ? { ...widths, collapsed: width } : { ...widths, expanded: width };
	emit();
}

/** Reactive pair of rail widths; stable snapshot identity per width change. */
export function useRailWidths(): RailWidths {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => snapshot,
	);
}
