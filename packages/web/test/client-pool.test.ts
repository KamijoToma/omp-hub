/**
 * `ClientPool` — warm `GuestClient` reuse across session switches: same
 * instance on re-acquire, LRU eviction beyond the cap, reopen re-minting,
 * and link-parse failures surfaced per session without poisoning the pool.
 */
import { describe, expect, test } from "bun:test";
import type { GuestClient } from "../src/lib/client";
import { ClientPool } from "../src/hub/client-pool";

interface FakeClient {
	client: GuestClient;
	connects(): number;
	closed(): boolean;
}

function fakeFactory() {
	const made: FakeClient[] = [];
	return {
		/** Minimal GuestClient stand-in: the pool only drives `connect`/`close`. */
		create: (_link: string): GuestClient => {
			let connects = 0;
			let closed = false;
			const client = {
				connect: () => {
					connects += 1;
				},
				close: () => {
					closed = true;
				},
			} as unknown as GuestClient;
			made.push({ client, connects: () => connects, closed: () => closed });
			return client;
		},
		made: (): readonly FakeClient[] => made,
		find: (client: GuestClient): FakeClient => made.find(fake => fake.client === client)!,
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
