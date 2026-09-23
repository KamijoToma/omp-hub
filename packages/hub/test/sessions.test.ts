/**
 * SessionRecord store contract (docs/protocol.md §3): id shape, display-name default,
 * terminal-state handling and the 500-record pruning cap (oldest exited first).
 */
import { describe, expect, test } from "bun:test";
import { SESSION_CAP, SessionStore } from "../src/sessions";

describe("session store", () => {
	test("assigns s_<10 base36> ids and defaults the display name to basename(cwd)", () => {
		const store = new SessionStore();
		const record = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/projects/demo" });
		expect(record.id).toMatch(/^s_[0-9a-z]{10}$/);
		expect(record.name).toBe("demo");
		expect(record.status).toBe("starting");
		expect(store.list()).toEqual([record]);

		const named = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/x", name: "  custom  " });
		expect(named.name).toBe("custom");
		// Newest first.
		expect(store.list().map((session) => session.id)).toEqual([named.id, record.id]);
		expect(store.countActiveFor("m")).toBe(2);
	});

	test("pruning keeps the cap by dropping the oldest terminal records first", () => {
		const store = new SessionStore();
		const ids: string[] = [];
		for (let index = 0; index < SESSION_CAP; index++) {
			const record = store.create({ machineId: "m", machineName: "machine", cwd: `/srv/${index}` });
			ids.push(record.id);
			if (index < SESSION_CAP - 1) store.markExited(record.id, "done");
		}
		const survivor = ids[SESSION_CAP - 1]!; // still live when the cap overflows
		const overflow = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/new" });

		expect(store.list()).toHaveLength(SESSION_CAP);
		expect(store.get(ids[0]!)).toBeUndefined(); // oldest exited record dropped
		expect(store.get(ids[1]!)).toBeDefined();
		expect(store.get(survivor)?.status).toBe("starting"); // live sessions are never pruned
		expect(store.get(overflow.id)).toBeDefined();
		expect(store.list()[0]?.id).toBe(overflow.id);
		expect(store.countActiveFor("m")).toBe(2);
	});

	test("the first terminal state sticks", () => {
		const store = new SessionStore();
		const exited = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/a" });
		store.markExited(exited.id, "user stop");
		const exitedAt = exited.exitedAt;
		store.markExited(exited.id, "agent lost");
		expect(exited.exitReason).toBe("user stop");
		expect(exited.exitedAt).toBe(exitedAt);

		const failed = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/b" });
		store.markFailed(failed.id, "spawn failed");
		store.markExited(failed.id, "child exit");
		store.markReady(failed.id, { links: { full: "a", view: "b", web: "c", webView: "d" } });
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("spawn failed");
		expect(failed.links).toBeUndefined();
	});
});
