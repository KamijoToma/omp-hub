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

	test("reissue re-arms a terminal record under the same id and tracks restart grace", () => {
		const store = new SessionStore();
		const record = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/rs", name: "rs", profile: "work" });
		store.markReady(record.id, { sessionFile: "/tmp/rs.jsonl", pid: 7, links: { full: "a", view: "b", web: "c", webView: "d" } });
		store.markExited(record.id, "crashed");

		const fresh = store.reissue(record.id);
		expect(fresh).toBe(record);
		expect(record.status).toBe("starting");
		expect(record.sessionFile).toBe("/tmp/rs.jsonl"); // identity survives
		expect(record.exitReason).toBeUndefined();
		expect(record.exitedAt).toBeUndefined();
		expect(record.links).toBeUndefined();
		expect(store.inRestartGrace(record.id)).toBe(true);
		expect(store.inRestartGrace("s_missing")).toBe(false);

		// The grace window ends with the outcome: ready flips to live and any
		// later terminal state leaves the record outside the reconcile again.
		store.markReady(record.id, { sessionFile: "/tmp/rs.jsonl" });
		store.markExited(record.id, "exit again");
		expect(record.status).toBe("exited");
	});

	test("reissue keeps the daemon-restart contract by default: no sessionFile, no re-arm", () => {
		const store = new SessionStore();
		const record = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/x" });
		store.markFailed(record.id, "spawn failed");
		expect(store.reissue(record.id)?.status).toBe("failed"); // unchanged

		// A user restart may re-arm it as a fresh start (same id, no resume).
		const fresh = store.reissue(record.id, { requireSessionFile: false });
		expect(fresh?.status).toBe("starting");
		expect(fresh?.error).toBeUndefined();
		expect(store.inRestartGrace(record.id)).toBe(true);
	});

	test("delete drops the restart grace entry with the record", () => {
		const store = new SessionStore();
		const record = store.create({ machineId: "m", machineName: "machine", cwd: "/srv/y" });
		store.markExited(record.id, "done");
		store.reissue(record.id, { requireSessionFile: false });
		expect(store.inRestartGrace(record.id)).toBe(true);
		store.delete(record.id);
		expect(store.inRestartGrace(record.id)).toBe(false);
	});
});
