/**
 * Shared hub notice poller (protocol §3 `GET /api/notices`, 0.8.0+): one
 * poll behind a `useSyncExternalStore` store, only running while at least one
 * subscriber is attached — same shape as the sessions store. Consumers are the
 * toast watcher and any surface that lists notices; the first poll a page sees
 * is the toast baseline, so pre-existing notices never replay.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { errorText, getNotices, type Notice } from "./api";
import { pushToast } from "./toasts";

/** Notice poll cadence; matches the sessions-store registry poll. */
const DEFAULT_POLL_MS = 2000;

export interface NoticesSnapshot {
	/** Monotonic bump per store mutation; snapshot object is stable per version. */
	readonly version: number;
	/** Last good listing (newest first); retained (stale) across poll errors. */
	readonly notices: readonly Notice[] | null;
	/** Last poll error, cleared on the next good poll. */
	readonly error: string | null;
}

export interface NoticesStoreOptions {
	/** Test seam; defaults to the real hub API call. */
	fetchNotices?: typeof getNotices;
	pollMs?: number;
}

export interface NoticesStore {
	subscribe(listener: () => void): () => void;
	getSnapshot(): NoticesSnapshot;
}

export function createNoticesStore(opts: NoticesStoreOptions = {}): NoticesStore {
	const fetchNotices = opts.fetchNotices ?? getNotices;
	const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

	let version = 0;
	let notices: readonly Notice[] | null = null;
	let error: string | null = null;
	let snapshot: NoticesSnapshot = { version, notices: null, error: null };

	const listeners = new Set<() => void>();
	let timer: Timer | null = null;
	let inFlight = false;

	function emit(): void {
		version += 1;
		snapshot = { version, notices, error };
		for (const listener of listeners) listener();
	}

	async function poll(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			notices = await fetchNotices();
			error = null;
		} catch (err) {
			// Hub hiccup: keep showing the stale listing.
			error = errorText(err);
		}
		inFlight = false;
		emit();
	}

	function ensureStarted(): void {
		if (timer !== null || listeners.size === 0) return;
		void poll();
		timer = setInterval(() => void poll(), pollMs);
	}

	function maybeStopped(): void {
		if (listeners.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			ensureStarted();
			return () => {
				listeners.delete(listener);
				maybeStopped();
			};
		},
		getSnapshot() {
			return snapshot;
		},
	};
}

/** Process-wide store; the hub-page toast watcher owns the only subscription. */
export const noticesStore = createNoticesStore();

/** The polled listing plus its poll error. */
export function useNotices(): { notices: readonly Notice[] | null; error: string | null } {
	const snapshot = useSyncExternalStore(noticesStore.subscribe, noticesStore.getSnapshot, noticesStore.getSnapshot);
	return { notices: snapshot.notices, error: snapshot.error };
}

/**
 * Notices in `next` whose id is not in `seenIds`, in listing order. The
 * caller's first sight baselines by passing every known id — brand-new pages
 * must not replay notices that predate them.
 */
export function diffNotices(seenIds: readonly string[], next: readonly Notice[]): Notice[] {
	const seen = new Set(seenIds);
	return next.filter(notice => !seen.has(notice.id));
}

/** Hub urgency → the local toast levels (`Notice["level"]`). */
const URGENCY_LEVEL = { info: "info", warn: "warning", urgent: "error" } as const;

/**
 * Toasts notices as they arrive on the hub-page poll: the first sight is the
 * baseline (nothing toasted), every later new id pushes exactly one toast.
 */
export function useNoticeToasts(): void {
	const { notices } = useNotices();
	const seenRef = useRef<readonly string[] | null>(null);

	useEffect(() => {
		if (!notices) return;
		const fresh = diffNotices(seenRef.current ?? notices.map(notice => notice.id), notices);
		seenRef.current = notices.map(notice => notice.id);
		for (const notice of fresh) pushToast(URGENCY_LEVEL[notice.urgency], notice.message);
	}, [notices]);
}
