import { useSyncExternalStore } from "react";

/** A browser-only presentation choice; the underlying session stays untouched. */
export type TranscriptMode = "full" | "body";

const KEY = "omp.transcript-mode";

export function parseTranscriptMode(raw: string | null): TranscriptMode {
	return raw === "body" ? "body" : "full";
}

function load(): TranscriptMode {
	try {
		return parseTranscriptMode(globalThis.localStorage?.getItem(KEY) ?? null);
	} catch {
		return "full";
	}
}

let mode = load();
const listeners = new Set<() => void>();

export function setTranscriptMode(next: TranscriptMode): void {
	if (mode === next) return;
	mode = next;
	try {
		globalThis.localStorage?.setItem(KEY, next);
	} catch {
		// Browsers without writable storage keep the choice for this page load.
	}
	for (const listener of listeners) listener();
}

export function useTranscriptMode(): TranscriptMode {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => mode,
		() => mode,
	);
}
