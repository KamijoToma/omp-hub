/**
 * Shared ticking clock for countdown labels (reset rail, quota matrix).
 * One interval per consumer at a 30s cadence — countdowns are minute-grain,
 * and text-only updates keep the tab cheap.
 */
import { useEffect, useState } from "react";

/** Epoch ms, re-rendered every `stepMs` while mounted. */
export function useNow(stepMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), stepMs);
		return () => clearInterval(timer);
	}, [stepMs]);
	return now;
}

/** Class for a provider hue index: `hb-uz-h0..3`, or `hb-uz-hrest` for -1. */
export function hueClass(index: number): string {
	return index >= 0 ? `hb-uz-h${index}` : "hb-uz-hrest";
}
