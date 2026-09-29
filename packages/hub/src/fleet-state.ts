import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomId } from "./sessions";

export interface FleetNamespace {
	id: string;
	name: string;
	/** null permits every registered machine; an empty list permits none. */
	machineIds: string[] | null;
}

export interface FleetMembership {
	namespaceId: string | null;
	membershipVersion: number;
	controllerId?: string;
}

export interface FleetEvent {
	id: string;
	sessionId: string;
	kind: string;
	createdAt: number;
	requestId?: string;
	leafId?: string;
	operationId?: string;
	error?: string;
}

interface NamespaceRow { id: string; name: string; machine_ids: string | null }
interface MembershipRow { namespace_id: string | null; version: number; controller_id: string | null }
interface EventRow { id: string; session_id: string; kind: string; created_at: number; payload: string }
export interface FleetStateSnapshot {
	namespaces: NamespaceRow[];
	memberships: Array<{ session_id: string; namespace_id: string | null; version: number; controller_id: string | null }>;
	watches: Array<{ owner_id: string; worker_id: string }>;
	inbox: Array<EventRow & { owner_id: string }>;
	processedSources: Array<{ session_id: string; id: string; created_at: number }>;
}

interface MutationGate {
	inFlight: number;
	moving: boolean;
	settled: Array<() => void>;
}

export class FleetMoveInProgressError extends Error {
	constructor() {
		super("session membership change in progress");
	}
}

const INBOX_INSERT_SQL = `INSERT OR IGNORE INTO inbox (owner_id, id, session_id, kind, created_at, payload)
	VALUES (?, ?, ?, ?, ?, ?)`;

/** Durable fleet authorization and notification inbox. The session registry remains the source of liveness. */
export class FleetState {
	readonly #db: Database;
	readonly #mutationGates = new Map<string, MutationGate>();

	constructor(file: string | null) {
		if (file !== null) mkdirSync(path.dirname(file), { recursive: true });
		this.#db = new Database(file ?? ":memory:", { create: true });
		if (file !== null) chmodSync(file, 0o600);
		this.#db.exec(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS namespaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, machine_ids TEXT);
			CREATE TABLE IF NOT EXISTS memberships (
				session_id TEXT PRIMARY KEY, namespace_id TEXT, version INTEGER NOT NULL DEFAULT 0, controller_id TEXT
			);
			CREATE TABLE IF NOT EXISTS watches (owner_id TEXT NOT NULL, worker_id TEXT NOT NULL,
				PRIMARY KEY(owner_id, worker_id));
			CREATE TABLE IF NOT EXISTS inbox (owner_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
				kind TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL,
				PRIMARY KEY(owner_id, id));
			CREATE TABLE IF NOT EXISTS source_events (session_id TEXT NOT NULL, id TEXT NOT NULL,
				created_at INTEGER NOT NULL, PRIMARY KEY(session_id, id));
			CREATE INDEX IF NOT EXISTS source_events_by_session ON source_events(session_id);
			CREATE INDEX IF NOT EXISTS watches_by_worker ON watches(worker_id);
			CREATE INDEX IF NOT EXISTS inbox_by_owner_time ON inbox(owner_id, created_at, id);
		`);
	}

	listNamespaces(): FleetNamespace[] {
		const rows = this.#db.query("SELECT id, name, machine_ids FROM namespaces ORDER BY name, id").all() as NamespaceRow[];
		return rows.map(row => ({ id: row.id, name: row.name, machineIds: row.machine_ids === null ? null : JSON.parse(row.machine_ids) as string[] }));
	}

	getNamespace(id: string): FleetNamespace | undefined {
		const row = this.#db.query("SELECT id, name, machine_ids FROM namespaces WHERE id = ?").get(id) as NamespaceRow | null;
		return row ? { id: row.id, name: row.name, machineIds: row.machine_ids === null ? null : JSON.parse(row.machine_ids) as string[] } : undefined;
	}

	createNamespace(name: string, machineIds: string[] | null): FleetNamespace {
		const namespace: FleetNamespace = { id: randomId("ns_"), name, machineIds };
		this.#db.query("INSERT INTO namespaces (id, name, machine_ids) VALUES (?, ?, ?)").run(namespace.id, name, machineIds === null ? null : JSON.stringify(machineIds));
		return namespace;
	}

	/** Existing sessions without a membership row start unassigned, even after an upgrade. */
	membership(sessionId: string): FleetMembership {
		const row = this.#db.query("SELECT namespace_id, version, controller_id FROM memberships WHERE session_id = ?").get(sessionId) as MembershipRow | null;
		return row ? { namespaceId: row.namespace_id, membershipVersion: row.version, ...(row.controller_id ? { controllerId: row.controller_id } : {}) }
			: { namespaceId: null, membershipVersion: 0 };
	}

	/** Register a worker mutation before dispatching it to a daemon. */
	async mutateWorker<T>(id: string, operation: () => Promise<T>): Promise<T> {
		let gate = this.#mutationGates.get(id);
		if (!gate) {
			gate = { inFlight: 0, moving: false, settled: [] };
			this.#mutationGates.set(id, gate);
		}
		if (gate.moving) throw new FleetMoveInProgressError();
		gate.inFlight++;
		try {
			return await operation();
		} finally {
			gate.inFlight--;
			if (gate.inFlight === 0) {
				for (const resolve of gate.settled) resolve();
				gate.settled.length = 0;
				if (!gate.moving) this.#mutationGates.delete(id);
			}
		}
	}

	/** Stop new mutations, wait for accepted commands to settle, then change membership. */
	async moveSessions<T>(ids: readonly string[], apply: () => T): Promise<T> {
		const unique = new Set(ids);
		for (const id of unique) {
			if (this.#mutationGates.get(id)?.moving) throw new FleetMoveInProgressError();
		}
		const gates: Array<{ id: string; gate: MutationGate }> = [];
		for (const id of unique) {
			let gate = this.#mutationGates.get(id);
			if (!gate) {
				gate = { inFlight: 0, moving: false, settled: [] };
				this.#mutationGates.set(id, gate);
			}
			gates.push({ id, gate });
		}
		for (const { gate } of gates) gate.moving = true;
		try {
			const pending: Promise<void>[] = [];
			for (const { gate } of gates) {
				if (gate.inFlight > 0) pending.push(new Promise<void>(resolve => gate.settled.push(resolve)));
			}
			if (pending.length > 0) await Promise.all(pending);
			return apply();
		} finally {
			for (const { id, gate } of gates) {
				gate.moving = false;
				if (gate.inFlight === 0) this.#mutationGates.delete(id);
			}
		}
	}

	/** A single transaction fences future access and removes stale watches/inbox entries. */
	assign(sessionId: string, namespaceId: string | null, expectedVersion?: number): FleetMembership | null {
		return this.#db.transaction(() => {
			const current = this.membership(sessionId);
			if (expectedVersion !== undefined && current.membershipVersion !== expectedVersion) return null;
			if (namespaceId === current.namespaceId) return current;
			this.#db.query(`INSERT INTO memberships (session_id, namespace_id, version, controller_id)
				VALUES (?, ?, ?, NULL) ON CONFLICT(session_id) DO UPDATE SET
				namespace_id = excluded.namespace_id, version = excluded.version, controller_id = NULL`)
				.run(sessionId, namespaceId, current.membershipVersion + 1);
			this.#db.query("DELETE FROM watches WHERE worker_id = ? OR owner_id = ?").run(sessionId, sessionId);
			this.#db.query("DELETE FROM inbox WHERE session_id = ? OR owner_id = ?").run(sessionId, sessionId);
			this.#db.query("UPDATE memberships SET controller_id = NULL, version = version + 1 WHERE controller_id = ?").run(sessionId);
			return this.membership(sessionId);
		})();
	}

	claim(workerId: string, ownerId: string): FleetMembership | null {
		return this.#db.transaction(() => {
			const current = this.membership(workerId);
			if (!current.namespaceId || (current.controllerId && current.controllerId !== ownerId)) return null;
			if (current.controllerId === ownerId) return current;
			this.#db.query("UPDATE memberships SET controller_id = ?, version = version + 1 WHERE session_id = ?")
				.run(ownerId, workerId);
			return this.membership(workerId);
		})();
	}

	watch(ownerId: string, workerId: string): boolean {
		return this.#db.query("INSERT OR IGNORE INTO watches (owner_id, worker_id) VALUES (?, ?)").run(ownerId, workerId).changes > 0;
	}

	/** Persist a notification for one authorized recipient before attempting delivery. */
	enqueueFor(ownerId: string, event: FleetEvent): boolean {
		const result = this.#db.query(INBOX_INSERT_SQL)
			.run(ownerId, event.id, event.sessionId, event.kind, event.createdAt, JSON.stringify(event));
		return result.changes > 0;
	}

	/** The source-supplied id makes resends idempotent. Returns newly queued recipient ids. */
	enqueue(event: FleetEvent, eligible: (ownerId: string) => boolean): string[] {
		const watchers = this.#db.query("SELECT owner_id FROM watches WHERE worker_id = ?").all(event.sessionId) as { owner_id: string }[];
		const recipients: string[] = [];
		const payload = JSON.stringify(event);
		const insert = this.#db.query(INBOX_INSERT_SQL);
		this.#db.transaction(() => {
			// Inbox rows disappear on owner ack; keep this receipt so an agent
			// retry after a lost hub ack cannot recreate a processed event.
			const fresh = this.#db.query("INSERT OR IGNORE INTO source_events (session_id, id, created_at) VALUES (?, ?, ?)")
				.run(event.sessionId, event.id, event.createdAt);
			if (fresh.changes === 0) return;
			for (const { owner_id } of watchers) {
				if (!eligible(owner_id)) continue;
				if (insert.run(owner_id, event.id, event.sessionId, event.kind, event.createdAt, payload).changes > 0) {
					recipients.push(owner_id);
				}
			}
		})();
		return recipients;
	}

	events(ownerId: string): FleetEvent[] {
		const rows = this.#db.query("SELECT id, session_id, kind, created_at, payload FROM inbox WHERE owner_id = ? ORDER BY created_at, id LIMIT 200")
			.all(ownerId) as EventRow[];
		return rows.map(row => JSON.parse(row.payload) as FleetEvent);
	}

	ack(ownerId: string, eventId: string): boolean {
		return this.#db.query("DELETE FROM inbox WHERE owner_id = ? AND id = ?").run(ownerId, eventId).changes > 0;
	}

	/** Remove live watches when an operator exits; membership remains for history/administration. */
	removeOwner(ownerId: string): void {
		this.#db.transaction(() => {
			this.#db.query("DELETE FROM watches WHERE owner_id = ?").run(ownerId);
			this.#db.query("DELETE FROM inbox WHERE owner_id = ?").run(ownerId);
			this.#db.query("UPDATE memberships SET controller_id = NULL, version = version + 1 WHERE controller_id = ?").run(ownerId);
		})();
	}

	/** Roll back a start whose frame never reached the machine, or forget a deleted record. */
	removeSession(sessionId: string): void {
		this.#db.transaction(() => {
			this.#db.query("DELETE FROM watches WHERE worker_id = ? OR owner_id = ?").run(sessionId, sessionId);
			this.#db.query("DELETE FROM inbox WHERE session_id = ? OR owner_id = ?").run(sessionId, sessionId);
			this.#db.query("DELETE FROM source_events WHERE session_id = ?").run(sessionId);
			this.#db.query("UPDATE memberships SET controller_id = NULL, version = version + 1 WHERE controller_id = ?").run(sessionId);
			this.#db.query("DELETE FROM memberships WHERE session_id = ?").run(sessionId);
		})();
	}

	/** Registry pruning removes old terminal records; reclaim their receipts and control grants. */
	pruneOrphans(knownSessionIds: ReadonlySet<string>): number {
		const rows = this.#db.query("SELECT session_id FROM memberships").all() as { session_id: string }[];
		let removed = 0;
		for (const row of rows) {
			if (knownSessionIds.has(row.session_id)) continue;
			this.removeSession(row.session_id);
			removed++;
		}
		return removed;
	}

	/** Dev hot-reload transfers in-memory state; file-backed instances use the same representation. */
	snapshot(): FleetStateSnapshot {
		return {
			namespaces: this.#db.query("SELECT id, name, machine_ids FROM namespaces").all() as NamespaceRow[],
			memberships: this.#db.query("SELECT session_id, namespace_id, version, controller_id FROM memberships").all() as FleetStateSnapshot["memberships"],
			watches: this.#db.query("SELECT owner_id, worker_id FROM watches").all() as FleetStateSnapshot["watches"],
			inbox: this.#db.query("SELECT owner_id, id, session_id, kind, created_at, payload FROM inbox").all() as FleetStateSnapshot["inbox"],
			processedSources: this.#db.query("SELECT session_id, id, created_at FROM source_events").all() as FleetStateSnapshot["processedSources"],
		};
	}

	restore(snapshot: FleetStateSnapshot): void {
		this.#db.transaction(() => {
			this.#db.exec("DELETE FROM inbox; DELETE FROM watches; DELETE FROM memberships; DELETE FROM namespaces; DELETE FROM source_events;");
			for (const row of snapshot.namespaces) this.#db.query("INSERT INTO namespaces VALUES (?, ?, ?)").run(row.id, row.name, row.machine_ids);
			for (const row of snapshot.memberships) this.#db.query("INSERT INTO memberships VALUES (?, ?, ?, ?)").run(row.session_id, row.namespace_id, row.version, row.controller_id);
			for (const row of snapshot.watches) this.#db.query("INSERT INTO watches VALUES (?, ?)").run(row.owner_id, row.worker_id);
			for (const row of snapshot.inbox) this.#db.query("INSERT INTO inbox VALUES (?, ?, ?, ?, ?, ?)").run(row.owner_id, row.id, row.session_id, row.kind, row.created_at, row.payload);
			for (const row of snapshot.processedSources) this.#db.query("INSERT INTO source_events VALUES (?, ?, ?)").run(row.session_id, row.id, row.created_at);
		})();
	}

	close(): void {
		this.#db.close();
	}
}
