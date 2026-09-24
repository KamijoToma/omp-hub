/**
 * `createSessionsStore` — the shared `/api/sessions` poller: single poll loop
 * while subscribed, stale listing retained across poll errors, per-id detail
 * fetches overlaid into the record cache, and detail errors isolated per id.
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/hub/api";
import { createSessionsStore, type SessionsStore } from "../src/hub/sessions-store";

function record(overrides: Partial<SessionRecord>): SessionRecord {
	return {
		id: "ses_a",
		machineId: "m1",
		machineName: "dev-machine",
		cwd: "/srv/api",
		name: "api work",
		status: "live",
		startedAt: Date.now(),
		...overrides,
	};
}

/** Minimal yield between poll-loop ticks; the store owns the real interval. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 1);
	return promise;
}

async function until(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`condition not met: ${label}`);
		await tick();
	}
}

describe("sessions store", () => {
	test("polls while subscribed and exposes listing + record cache", async () => {
		let polls = 0;
		const store = createSessionsStore({
			pollMs: 5,
			fetchSessions: async () => {
				polls += 1;
				return [record({})];
			},
		});
		const unsubscribe = store.subscribe(() => {});
		await until(() => store.getSnapshot().sessions !== null, "first poll");
		expect(store.record("ses_a")?.name).toBe("api work");
		const pollsAfterFirst = polls;
		await until(() => polls > pollsAfterFirst, "subsequent polls");
		unsubscribe();
	});

	test("keeps the stale listing when a poll fails, clears on recovery", async () => {
		let fail = false;
		const good = [record({})];
		const store = createSessionsStore({
			pollMs: 5,
			fetchSessions: async () => {
				if (fail) throw new Error("hub down");
				return good;
			},
		});
		const unsubscribe = store.subscribe(() => {});
		await until(() => store.getSnapshot().sessions !== null, "first poll");
		fail = true;
		await until(() => store.getSnapshot().error !== null, "error surfaces");
		expect(store.getSnapshot().sessions).toEqual(good);
		expect(store.record("ses_a")).not.toBeNull();
		fail = false;
		await until(() => store.getSnapshot().error === null, "error clears");
		unsubscribe();
	});

	test("refreshSession overlays detail into the record cache", async () => {
		const detail = record({ id: "ses_b", name: "detail view", status: "starting" });
		let detailFetches = 0;
		const store: SessionsStore = createSessionsStore({
			pollMs: 60_000,
			fetchSessions: async () => [],
			fetchSession: async () => {
				detailFetches += 1;
				return detail;
			},
		});
		const unsubscribe = store.subscribe(() => {});
		expect(await store.refreshSession("ses_b")).toEqual(detail);
		expect(detailFetches).toBe(1);
		expect(store.record("ses_b")?.name).toBe("detail view");
		// No detail error once the id resolves.
		expect(store.detailError("ses_b")).toBeNull();
		unsubscribe();
	});

	test("refreshSession failures surface as per-id errors without poisoning the listing", async () => {
		const store = createSessionsStore({
			pollMs: 60_000,
			fetchSessions: async () => [record({})],
			fetchSession: async id => {
				if (id === "ses_missing") throw new Error("not found");
				return record({ id });
			},
		});
		const unsubscribe = store.subscribe(() => {});
		expect(await store.refreshSession("ses_missing")).toBeNull();
		expect(store.detailError("ses_missing")).toBe("not found");
		expect(store.record("ses_missing")).toBeNull();
		expect(store.getSnapshot().sessions).toHaveLength(1);
		// A later success clears the error.
		expect(await store.refreshSession("ses_ok")).not.toBeNull();
		expect(store.detailError("ses_ok")).toBeNull();
		unsubscribe();
	});

	test("stops polling once the last subscriber leaves", async () => {
		let polls = 0;
		const store = createSessionsStore({
			pollMs: 5,
			fetchSessions: async () => {
				polls += 1;
				return [record({})];
			},
		});
		const unsubscribe = store.subscribe(() => {});
		await until(() => store.getSnapshot().sessions !== null, "first poll");
		const pollsAtLeave = polls;
		unsubscribe();
		// Let the in-flight poll settle; the interval itself is cleared
		// synchronously on unsubscribe, so no further ticks can start.
		await tick();
		await tick();
		await tick();
		expect(polls).toBe(pollsAtLeave);
	});
});
