/**
 * GuestClient pool for the session page: keeps a small LRU of live collab
 * clients keyed by hub session id so switching sessions reuses a warm replica
 * (full transcript already in the snapshot) instead of paying the relay
 * handshake + snapshot replay on every switch. Backgrounded clients stay
 * connected and keep applying frames, so returning to a session is equally
 * fresh. A client that reached `ended` stays pooled (its banner and Rejoin
 * action remain visible; re-acquiring it must not spawn a reconnect loop).
 */
import { useCallback, useEffect, useReducer } from "react";
import { GuestClient } from "../lib/client";

/** Active + recently visited; each entry is a real relay peer, so stay small. */
const DEFAULT_MAX = 3;

export interface ClientPoolOptions {
	max?: number;
	/** Test seam; defaults to the real `GuestClient`. */
	create?: (link: string, displayName: string) => GuestClient;
}

interface PoolEntry {
	client: GuestClient;
	link: string;
	lastUsed: number;
}

export class ClientPool {
	readonly #max: number;
	readonly #create: (link: string, displayName: string) => GuestClient;
	readonly #entries = new Map<string, PoolEntry>();
	readonly #errors = new Map<string, string>();
	readonly #listeners = new Set<() => void>();
	#version = 0;
	#snapshot = { version: 0 };

	constructor(opts: ClientPoolOptions = {}) {
		this.#max = Math.max(1, opts.max ?? DEFAULT_MAX);
		this.#create = opts.create ?? ((link, displayName) => new GuestClient(link, displayName));
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
				entry.lastUsed = Date.now();
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
		this.#entries.set(sessionId, { client, link, lastUsed: Date.now() });
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
		try {
			entry.client.close();
		} catch {
			// Closing a half-open socket must not mask the pool operation.
		}
		this.#bump();
	}

	/** Drop least-recently-used entries beyond the cap, never the keeper. */
	#evict(keepId: string): void {
		while (this.#entries.size > this.#max) {
			let oldestId: string | null = null;
			let oldestAt = Infinity;
			for (const [id, entry] of this.#entries) {
				if (id === keepId) continue;
				if (entry.lastUsed < oldestAt) {
					oldestAt = entry.lastUsed;
					oldestId = id;
				}
			}
			if (oldestId === null) break;
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
