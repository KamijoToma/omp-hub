/**
 * `ClientPool` — warm guests across route changes, bounded pre-connection,
 * foreground priority, link rotation, retry and cleanup.
 */
import { describe, expect, test } from "bun:test";
import type { GuestClient, ConnectionPhase } from "../src/lib/client";
import type { SessionRecord } from "../src/hub/api";
import { ClientPool } from "../src/hub/client-pool";

interface FakeClient {
	client: GuestClient;
	connects(): number;
	closed(): boolean;
	setPhase(phase: ConnectionPhase): void;
}

function fakeFactory() {
	const made: FakeClient[] = [];
	return {
		/** Minimal GuestClient stand-in: the pool only drives `connect`/`close`. */
		create: (_link: string): GuestClient => {
			let connects = 0;
			let closed = false;
			let phase: ConnectionPhase = "live";
			const client = {
				connect: () => {
					connects += 1;
				},
				close: () => {
					closed = true;
				},
				getSnapshot: () => ({ phase }),
			} as unknown as GuestClient;
			made.push({ client, connects: () => connects, closed: () => closed, setPhase: next => { phase = next; } });
			return client;
		},
		made: (): readonly FakeClient[] => made,
		find: (client: GuestClient): FakeClient => made.find(fake => fake.client === client)!,
	};
}

function record(id: string, activity?: SessionRecord["activity"]): SessionRecord {
	return {
		id, machineId: "machine", machineName: "machine", cwd: "/tmp", name: id,
		status: "live", startedAt: 1,
		links: { full: `link-${id}`, view: "", web: "", webView: "" },
		activity,
	};
}

describe("client pool", () => {
	test("reuses one connected client per session", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 3, create: factory.create });
		const first = pool.acquire("ses_a", "link-a", "Guest");
		expect(first).not.toBeNull();
		expect(pool.acquire("ses_a", "link-a", "Guest")).toBe(first);
		expect(factory.made()).toHaveLength(1);
		expect(factory.made()[0]!.connects()).toBe(1);
	});

	test("evicts the least recently used session beyond the cap", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 2, create: factory.create });
		const a = pool.acquire("ses_a", "link-a", "Guest");
		const b = pool.acquire("ses_b", "link-b", "Guest");
		pool.acquire("ses_c", "link-c", "Guest");
		expect(pool.size()).toBe(2);
		// `a` was touched longest ago; `b` and the new client stay warm.
		expect(factory.find(a!).closed()).toBe(true);
		expect(factory.find(b!).closed()).toBe(false);
		// Re-acquiring the evicted session mints a fresh, connected client.
		const again = pool.acquire("ses_a", "link-a", "Guest");
		expect(again).not.toBe(a);
		expect(factory.made()).toHaveLength(4);
	});

	test("recent use wins even when switches happen in one millisecond", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 3, create: factory.create });
		const a = pool.acquire("a", "link-a", "Guest")!;
		const b = pool.acquire("b", "link-b", "Guest")!;
		pool.acquire("c", "link-c", "Guest");
		pool.acquire("a", "link-a", "Guest");
		pool.acquire("d", "link-d", "Guest");
		expect(pool.peek("a")).toBe(a);
		expect(pool.peek("b")).toBeNull();
		expect(factory.find(b).closed()).toBe(true);
	});

	test("preconnects bounded live rooms, retains the foreground, and replaces an out-of-date link", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 2, create: factory.create });
		const a = record("a");
		const b = record("b");
		const c = record("c", { working: false, inputRequired: true, updatedAt: 1 });
		pool.sync([a, b], "a", "Guest");
		const foreground = pool.peek("a");
		const previousB = pool.peek("b");
		pool.sync([a, b, c], "a", "Guest");
		expect(pool.peek("a")).toBe(foreground);
		expect(pool.peek("b")).toBeNull();
		expect(factory.find(previousB!).closed()).toBe(true);
		const warmed = pool.peek("c");
		expect(warmed).not.toBeNull();
		pool.sync([a, b, c], "a", "Guest");
		expect(pool.peek("c")).toBe(warmed);
		const updated = { ...c, links: { ...c.links!, full: "new-c-link" } };
		pool.sync([a, b, updated], "a", "Guest");
		expect(pool.peek("c")).not.toBe(warmed);
		expect(factory.find(warmed!).closed()).toBe(true);
		pool.closeAll();
		expect(pool.size()).toBe(0);
		expect(factory.find(foreground!).closed()).toBe(true);
	});

	test("hidden sessions are not preconnected and deletion closes an existing peer", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 3, create: factory.create });
		pool.sync([record("a"), record("b")], "a", "Guest", new Set(["b"]));
		expect(pool.peek("b")).toBeNull();
		const a = pool.peek("a")!;
		pool.discard("a");
		expect(factory.find(a).closed()).toBe(true);
		expect(pool.peek("a")).toBeNull();
	});

	test("only background rooms reported live retry a fatal close", () => {
		let now = 0;
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 3, create: factory.create, now: () => now });
		const a = record("a");
		const b = record("b");
		pool.sync([a, b], "a", "Guest");
		const background = pool.peek("b")!;
		factory.find(background).setPhase("ended");
		pool.sync([a, b], "a", "Guest");
		now = 999;
		pool.sync([a, b], "a", "Guest");
		expect(pool.peek("b")).toBe(background);
		now = 1_000;
		pool.sync([a, b], "a", "Guest");
		expect(pool.peek("b")).not.toBe(background);
		expect(factory.find(background).closed()).toBe(true);
		const afterRetry = pool.peek("b")!;
		factory.find(afterRetry).setPhase("ended");
		pool.sync([a, { ...b, status: "exited" }], "a", "Guest");
		expect(pool.peek("b")).toBe(afterRetry);
		now = 40_000;
		pool.sync([a, { ...b, status: "exited" }], "a", "Guest");
		expect(pool.peek("b")).toBe(afterRetry);
	});

	test("reopen closes the old client and re-mints", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 3, create: factory.create });
		const first = pool.acquire("ses_a", "link-a", "Guest");
		const second = pool.reopen("ses_a", "link-a", "Guest");
		expect(second).not.toBe(first);
		expect(factory.find(first!).closed()).toBe(true);
		expect(pool.peek("ses_a")).toBe(second);
	});

	test("a changed link re-mints the client", () => {
		const factory = fakeFactory();
		const pool = new ClientPool({ max: 3, create: factory.create });
		const first = pool.acquire("ses_a", "link-a", "Guest");
		const second = pool.acquire("ses_a", "link-a2", "Guest");
		expect(second).not.toBe(first);
		expect(factory.find(first!).closed()).toBe(true);
	});

	test("link parse failures surface per session and clear on success", () => {
		let broken = true;
		const pool = new ClientPool({
			max: 3,
			create: () => {
				if (broken) throw new Error("bad link");
				return fakeFactory().create("ok");
			},
		});
		expect(pool.acquire("ses_a", "link-a", "Guest")).toBeNull();
		expect(pool.error("ses_a")).toBe("bad link");
		expect(pool.peek("ses_a")).toBeNull();
		broken = false;
		expect(pool.acquire("ses_a", "link-a", "Guest")).not.toBeNull();
		expect(pool.error("ses_a")).toBeNull();
	});
});
