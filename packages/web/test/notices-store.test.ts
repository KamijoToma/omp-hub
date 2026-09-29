/**
 * Notices store and toast diff: the poll only runs while subscribed, the first
 * sight baselines (no toast replay), and every later new id toasts exactly
 * once (protocol §3 `GET /api/notices`, 0.8.0+).
 */
import { describe, expect, test } from "bun:test";
import type { Notice } from "../src/hub/api";
import { createNoticesStore, diffNotices, type NoticesStore } from "../src/hub/notices-store";

function notice(overrides: Partial<Notice>): Notice {
	return { id: "n_a", message: "hello", urgency: "info", createdAt: 1, ...overrides };
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

describe("notices store", () => {
	test("polls while subscribed and exposes the listing", async () => {
		let polls = 0;
		const store: NoticesStore = createNoticesStore({
			pollMs: 5,
			fetchNotices: async () => {
				polls += 1;
				return [notice({})];
			},
		});
		const unsubscribe = store.subscribe(() => {});
		await until(() => store.getSnapshot().notices !== null, "first poll");
		expect(store.getSnapshot().notices?.map(entry => entry.id)).toEqual(["n_a"]);
		const pollsAfterFirst = polls;
		await until(() => polls > pollsAfterFirst, "subsequent polls");
		unsubscribe();
	});

	test("keeps the stale listing when a poll fails, clears on recovery", async () => {
		let fail = false;
		const good = [notice({})];
		const store = createNoticesStore({
			pollMs: 5,
			fetchNotices: async () => {
				if (fail) throw new Error("hub down");
				return good;
			},
		});
		const unsubscribe = store.subscribe(() => {});
		await until(() => store.getSnapshot().notices !== null, "first poll");
		fail = true;
		await until(() => store.getSnapshot().error !== null, "error surfaces");
		expect(store.getSnapshot().notices).toEqual(good);
		fail = false;
		await until(() => store.getSnapshot().error === null, "error clears");
		unsubscribe();
	});

	test("stops polling once the last subscriber leaves", async () => {
		let polls = 0;
		const store = createNoticesStore({
			pollMs: 5,
			fetchNotices: async () => {
				polls += 1;
				return [notice({})];
			},
		});
		const unsubscribe = store.subscribe(() => {});
		await until(() => store.getSnapshot().notices !== null, "first poll");
		const pollsAtLeave = polls;
		unsubscribe();
		await tick();
		await tick();
		await tick();
		expect(polls).toBe(pollsAtLeave);
	});
});

describe("diffNotices", () => {
	test("the baseline poll toasts nothing", () => {
		const listing = [notice({ id: "n_1" }), notice({ id: "n_2" })];
		expect(diffNotices(listing.map(entry => entry.id), listing)).toEqual([]);
	});

	test("a new id toasts exactly once", () => {
		const known = [notice({ id: "n_1" })];
		const next = [notice({ id: "n_2" }), notice({ id: "n_1" })];
		const fresh = diffNotices(known.map(entry => entry.id), next);
		expect(fresh.map(entry => entry.id)).toEqual(["n_2"]);
		// The repeat poll with the same ids (now the seen set) is quiet.
		expect(diffNotices([...known.map(entry => entry.id), "n_2"], next)).toEqual([]);
	});

	test("an emptied listing never revives old ids", () => {
		const next = [notice({ id: "n_1" })];
		expect(diffNotices(["n_1", "n_gone"], next)).toEqual([]);
	});
});
