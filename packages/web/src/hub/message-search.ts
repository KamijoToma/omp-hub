/**
 * Message-text search behind the two session filter boxes (the rail picker and
 * the home History list): debounced fan-out to the machines behind the visible
 * rows, merged into a path → hit map. The pure grouping/merge helpers are
 * exported for tests; the hook is thin wiring over {@link searchSessionMessages}.
 */
import { useEffect, useMemo, useState } from "react";
import { searchSessionMessages, type SessionMessageHit } from "./api";

/** Queries shorter than this skip the message scan (single letters match everywhere). */
const MIN_QUERY_CHARS = 2;
/** Keystroke debounce before a scan round fires. */
const DEBOUNCE_MS = 300;

/** One machine's candidate session files (deduplicated by {@link groupSearchPaths}). */
export interface SearchGroup {
	machineId: string;
	paths: string[];
}

/** Path-keyed hits of the latest completed search round; `null` = metadata-only filtering. */
export type MessageMatches = Readonly<Record<string, SessionMessageHit>>;

/**
 * Candidate paths per machine, in first-seen row order: rows without a session
 * file (older agents) are unsearchable and drop out.
 */
export function groupSearchPaths<T>(rows: readonly T[], keyOf: (row: T) => { machineId: string; path: string } | undefined): SearchGroup[] {
	const pathsByMachine = new Map<string, Set<string>>();
	for (const row of rows) {
		const key = keyOf(row);
		if (key === undefined || key.path === "") continue;
		let seen = pathsByMachine.get(key.machineId);
		if (seen === undefined) pathsByMachine.set(key.machineId, (seen = new Set()));
		seen.add(key.path);
	}
	return [...pathsByMachine].map(([machineId, paths]) => ({ machineId, paths: [...paths] }));
}

/**
 * Filtered rows plus the rows that matched only in message text (a metadata
 * match keeps its registry/listing order; message-only hits trail it).
 */
export function mergeMessageMatches<T>(rows: readonly T[], pathOf: (row: T) => string | undefined, base: readonly T[], matches: MessageMatches | null): T[] {
	if (matches === null) return [...base];
	const matched = new Set<string>(Object.keys(matches));
	const extra = rows.filter(row => {
		const path = pathOf(row);
		return path !== undefined && matched.has(path) && !base.includes(row);
	});
	return [...base, ...extra];
}

/**
 * Live message hits for the current filter text. Groups are re-scanned only
 * when the debounced needle or the candidate path set changes; per-machine
 * failures (offline, timeout) read as "no hits from that machine" — the search
 * is best-effort alongside metadata filtering and never surfaces errors.
 */
export function useMessageMatches(groups: readonly SearchGroup[], query: string): MessageMatches | null {
	const needle = query.trim().toLowerCase();
	// Identity-stable key: registry polls replace row objects every 2 s, but an
	// unchanged path set must not restart the effect.
	const groupsKey = useMemo(() => JSON.stringify(groups), [groups]);
	const [matches, setMatches] = useState<MessageMatches | null>(null);

	useEffect(() => {
		if (needle.length < MIN_QUERY_CHARS) {
			setMatches(null);
			return;
		}
		const round = (JSON.parse(groupsKey) as SearchGroup[]).filter(group => group.paths.length > 0);
		if (round.length === 0) {
			setMatches(null);
			return;
		}
		// Stale-response guard: only the newest round may write state.
		let live = true;
		const timer = setTimeout(() => {
			void Promise.all(
				round.map(group =>
					searchSessionMessages(group.machineId, needle, group.paths)
						.then(hits => [group, hits] as const)
						// Offline/timeout machines contribute nothing instead of failing the round.
						.catch(() => [group, [] as SessionMessageHit[]] as const),
				),
			).then(pairs => {
				if (!live) return;
				const merged: Record<string, SessionMessageHit> = {};
				for (const [, hits] of pairs) for (const hit of hits) merged[hit.path] = hit;
				setMatches(merged);
			});
		}, DEBOUNCE_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [needle, groupsKey]);

	return matches;
}
