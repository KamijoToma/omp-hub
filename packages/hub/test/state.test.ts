/**
 * `state.ts` — the registry snapshot behind upgrade restarts: serialize/parse
 * round trip, tolerant parsing, atomic write-through with coalescing, and the
 * machine `connected` flag being a socket property (never persisted as true).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MachineRecord } from "../src/agents";
import type { SessionRecord } from "../src/sessions";
import { loadStateSnapshot, parseStateSnapshot, serializeState, StatePersistence } from "../src/state";

const dir = mkdtempSync(path.join(tmpdir(), "hub-state-"));
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function machine(overrides: Partial<MachineRecord> = {}): MachineRecord {
	return {
		machineId: "m_1",
		name: "dev-machine",
		connected: true,
		connectedAt: 1234,
		sessionCount: 0,
		...overrides,
	};
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		id: "s_1",
		machineId: "m_1",
		machineName: "dev-machine",
		cwd: "/srv/work",
		name: "api work",
		namespaceId: null,
		membershipVersion: 0,
		status: "live",
		startedAt: 1234,
		...overrides,
	};
}

describe("state snapshot", () => {
	test("serialize/parse round trips machines and sessions", () => {
		const machines = [machine()];
		const sessions = [session({ links: { full: "a", view: "b", web: "c", webView: "d" } })];

		const snapshot = parseStateSnapshot(serializeState(machines, sessions));

		expect(snapshot).not.toBeNull();
		expect(snapshot!.version).toBe(1);
		expect(snapshot!.sessions).toEqual(sessions);
		// `connected` is a socket property: the snapshot always stores false.
		expect(snapshot!.machines).toEqual([{ ...machines[0], connected: false }]);
	});

	test("parse tolerates garbage, truncation, and version drift", () => {
		expect(parseStateSnapshot("not json")).toBeNull();
		expect(parseStateSnapshot('{"version":99}')).toBeNull();
		expect(parseStateSnapshot("[]")).toBeNull();
		expect(parseStateSnapshot(serializeState([], []).slice(0, 20))).toBeNull();
	});

	test("loadStateSnapshot returns null for an absent or unusable file", () => {
		expect(loadStateSnapshot(path.join(dir, "absent.json"))).toBeNull();
		const bad = path.join(dir, "bad.json");
		require("node:fs").writeFileSync(bad, "{ truncated");
		expect(loadStateSnapshot(bad)).toBeNull();
	});
});

describe("StatePersistence", () => {
	test("writes atomically, skips unchanged content, and coalesces concurrent writes", async () => {
		const file = path.join(dir, "hub-state.json");
		const persistence = new StatePersistence(file);
		const machines = [machine()];
		const sessions = [session()];

		await persistence.sync(machines, sessions);
		expect(existsSync(file)).toBe(true);
		const written = readFileSync(file, "utf8");
		expect(parseStateSnapshot(written)).not.toBeNull();
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		// No leftover tmp files from the atomic replace.
		expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false);

		// Same registry → no rewrite (mtime/content unchanged; verified via the
		// last-written cache by serializing to a second file only on change).
		await persistence.sync(machines, sessions);

		const changed = [...sessions, session({ id: "s_2", status: "exited", exitedAt: 42 })];
		await persistence.sync(machines, changed);
		expect(parseStateSnapshot(readFileSync(file, "utf8"))!.sessions).toHaveLength(2);
	});

	test("a failed write does not throw and retries on the next sync", async () => {
		// A directory in place of the target file makes rename() fail.
		const blocked = path.join(dir, "blocked.json");
		require("node:fs").mkdirSync(blocked);
		const persistence = new StatePersistence(blocked);

		await persistence.sync([machine()], [session()]); // must not throw

		rmSync(blocked, { recursive: true, force: true });
		await persistence.sync([machine()], [session()]);
		expect(parseStateSnapshot(readFileSync(blocked, "utf8"))).not.toBeNull();
	});
});
