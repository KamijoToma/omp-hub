/**
 * Bounded pool of writable collab replicas. The session UI can unmount while
 * its client keeps applying encrypted frames; only explicit eviction closes it.
 */
import { useCallback, useEffect, useReducer } from "react";
import { GuestClient } from "../lib/client";
import type { SessionRecord } from "./api";
import { rejoinDelayMs } from "./auto-rejoin";

/** One foreground session and up to five warm background sessions. */
const DEFAULT_MAX = 6;
const EMPTY_HIDDEN: ReadonlySet<string> = new Set();

export interface ClientPoolOptions {
	max?: number;
	/** Test seam; defaults to the real `GuestClient`. */
	create?: (link: string, displayName: string) => GuestClient;
	now?: () => number;
}

interface PoolEntry {
	client: GuestClient;
	link: string;
	lastUsed: number;
}

export class ClientPool {
	readonly #max: number;
	readonly #create: (link: string, displayName: string) => GuestClient;
	readonly #now: () => number;
	readonly #entries = new Map<string, PoolEntry>();
	readonly #errors = new Map<string, string>();
	readonly #listeners = new Set<() => void>();
	#version = 0;
	#snapshot = { version: 0 };
	#activeId: string | null = null;
	#clock = 0;
	readonly #retries = new Map<string, { client: GuestClient; due: number; attempt: number }>();

	constructor(opts: ClientPoolOptions = {}) {
		this.#max = Math.max(1, opts.max ?? DEFAULT_MAX);
		this.#create = opts.create ?? ((link, displayName) => new GuestClient(link, displayName));
		this.#now = opts.now ?? Date.now;
	}

	/**
	 * Returns the pooled client for the session, creating and connecting one on
	 * first use. `null` means the link could not be parsed; see {@link error}.
	 */
	acquire(sessionId: string, link: string, displayName: string): GuestClient | null {
		this.#errors.delete(sessionId);
		const entry = this.#entries.get(sessionId);
		if (entry) {
			if (entry.link === link) {
				entry.lastUsed = ++this.#clock;
				this.#evict(sessionId);
				return entry.client;
			}
			// Links are stable per session; a changed link re-mints the client.
			this.#discard(sessionId);
		}
		let client: GuestClient;
		try {
			client = this.#create(link, displayName);
		} catch (err) {
			this.#errors.set(sessionId, err instanceof Error ? err.message : String(err));
			this.#bump();
			return null;
		}
		client.connect();
		this.#entries.set(sessionId, { client, link, lastUsed: ++this.#clock });
		this.#evict(sessionId);
		this.#bump();
		return client;
	}

	/** Close and re-mint the client (the Banners "Rejoin" action). */
	reopen(sessionId: string, link: string, displayName: string): GuestClient | null {
		this.#discard(sessionId);
		return this.acquire(sessionId, link, displayName);
	}

	/** The pooled client for a session, if one exists. */
	peek(sessionId: string): GuestClient | null {
		return this.#entries.get(sessionId)?.client ?? null;
	}

	/** Stop one removed session immediately, including its cached credentials. */
	discard(sessionId: string): void {
		this.#errors.delete(sessionId);
		this.#discard(sessionId);
	}

	/**
	 * Keep the current session plus the most useful background sessions warm.
	 * Existing replicas are not touched on each registry poll: only actual
	 * navigation should change recency. Ended replicas can occupy spare slots.
	 */
	sync(
		sessions: readonly SessionRecord[],
		currentId: string | null,
		displayName: string,
		hidden: ReadonlySet<string> = EMPTY_HIDDEN,
		currentRecord?: SessionRecord | null,
	): void {
		this.#activeId = currentId;
		const known = new Map<string, SessionRecord>();
		for (const record of sessions) known.set(record.id, record);
		if (currentId && currentRecord?.id === currentId) known.set(currentId, currentRecord);
		const live = new Map<string, SessionRecord>();
		for (const record of known.values()) {
			if (record.status === "live" && record.links && (!hidden.has(record.id) || record.id === currentId)) live.set(record.id, record);
		}
		const selected: string[] = [];
		const offer = (id: string): void => {
			if (selected.length >= this.#max || selected.includes(id)) return;
			if (live.has(id) || (known.has(id) && this.#entries.has(id)) || (id === currentId && this.#entries.has(id))) selected.push(id);
		};
		if (currentId) offer(currentId);
		for (const record of live.values()) if (record.activity?.inputRequired) offer(record.id);
		for (const record of live.values()) if (record.activity?.working) offer(record.id);
		const recent = [...this.#entries].sort((a, b) => b[1].lastUsed - a[1].lastUsed);
		for (const [id] of recent) if (!hidden.has(id)) offer(id);
		for (const record of live.values()) offer(record.id);

		const kept = new Set(selected);
		for (const id of this.#entries.keys()) if (!kept.has(id)) this.#discard(id);
		for (const id of selected) {
			const record = known.get(id);
			if (record?.status !== "live" || !record.links) continue;
			if (this.#entries.get(id)?.link !== record.links.full) this.acquire(id, record.links.full, displayName);
		}
		// Off-screen clients cannot run SessionView's rejoin effect. A fatal
		// close may be temporary during host restart, so retry while still live.
		for (const id of selected) {
			const record = live.get(id);
			const client = this.#entries.get(id)?.client;
			if (!record?.links || !client || id === currentId) continue;
			const phase = client.getSnapshot().phase;
			if (phase === "live") {
				this.#retries.delete(id);
				continue;
			}
			if (phase !== "ended") continue;
			const previous = this.#retries.get(id);
			const now = this.#now();
			if (previous?.client !== client) {
				this.#retries.set(id, { client, due: now + rejoinDelayMs(previous?.attempt ?? 0), attempt: previous?.attempt ?? 0 });
			} else if (now >= previous.due) {
				const attempt = previous.attempt + 1;
				const next = this.reopen(id, record.links.full, displayName);
				if (next) this.#retries.set(id, { client: next, due: now + rejoinDelayMs(attempt), attempt });
			}
		}
	}

	/** The last link-parse failure for a session, if any. */
	error(sessionId: string): string | null {
		return this.#errors.get(sessionId) ?? null;
	}

	/** Pooled session count (test seam). */
	size(): number {
		return this.#entries.size;
	}

	/** Close every pooled client (test teardown). */
	closeAll(): void {
		this.#activeId = null;
		this.#errors.clear();
		this.#retries.clear();
		for (const id of [...this.#entries.keys()]) this.#discard(id);
		this.#bump();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getSnapshot(): { version: number } {
		return this.#snapshot;
	}

	#discard(sessionId: string): void {
		const entry = this.#entries.get(sessionId);
		if (!entry) return;
		this.#entries.delete(sessionId);
		this.#retries.delete(sessionId);
		try {
			entry.client.close();
		} catch {
			// Closing a half-open socket must not mask the pool operation.
		}
		this.#bump();
	}

	/** Drop the oldest entry, preferring not to evict the visible session. */
	#evict(keepId: string): void {
		while (this.#entries.size > this.#max) {
			let oldestId: string | null = null;
			let oldestAt = Infinity;
			for (const [id, entry] of this.#entries) {
				if (id === keepId || id === this.#activeId) continue;
				if (entry.lastUsed < oldestAt) {
					oldestAt = entry.lastUsed;
					oldestId = id;
				}
			}
			if (oldestId === null) oldestId = this.#activeId;
			if (oldestId === null || oldestId === keepId) break;
			this.#discard(oldestId);
		}
	}

	#bump(): void {
		this.#version += 1;
		this.#snapshot = { version: this.#version };
		for (const listener of this.#listeners) listener();
	}
}

/** Process-wide pool; the session page's surface uses this instance. */
export const clientPool = new ClientPool();

export interface PooledClient {
	client: GuestClient | null;
	error: string | null;
	rejoin(): void;
}

/**
 * React binding: acquire on mount/param change and re-render on pool
 * mutations (acquisitions, evictions, link failures).
 */
export function usePoolClient(sessionId: string, link: string, displayName: string): PooledClient {
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	// Acquire synchronously applies the pool change; the explicit rerender covers
	// the subscribe-effect ordering gap on first mount.
	useEffect(() => {
		clientPool.acquire(sessionId, link, displayName);
		rerender();
	}, [sessionId, link, displayName, rerender]);
	useEffect(() => clientPool.subscribe(rerender), [rerender]);
	const rejoin = useCallback(() => {
		clientPool.reopen(sessionId, link, displayName);
	}, [sessionId, link, displayName]);
	return { client: clientPool.peek(sessionId), error: clientPool.error(sessionId), rejoin };
}
