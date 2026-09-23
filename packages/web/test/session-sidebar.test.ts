/**
 * `filterHubSessions` — the sidebar/quick-switcher filter: case-insensitive
 * substring match on name, cwd, machine, id, or profile (absent profile reads
 * as "default", matching the resume picker).
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/hub/api";
import { filterHubSessions } from "../src/hub/SessionSidebar";

function record(overrides: Partial<SessionRecord>): SessionRecord {
	return {
		id: "ses_a",
		machineId: "m1",
		machineName: "dev-machine",
		cwd: "/home/sky/omp-hub",
		name: "auth refactor",
		status: "live",
		startedAt: 0,
		...overrides,
	};
}

const SESSIONS: SessionRecord[] = [
	record({}),
	record({ id: "ses_b", name: "flaky test hunt", cwd: "/srv/api", machineName: "build-box", profile: "work" }),
	record({ id: "ses_c", name: "dev-machine sweep", status: "exited" }),
];

describe("filterHubSessions", () => {
	test("empty or blank query keeps the listing order", () => {
		expect(filterHubSessions(SESSIONS, "")).toEqual(SESSIONS);
		expect(filterHubSessions(SESSIONS, "   ")).toEqual(SESSIONS);
	});

	test("matches name, cwd, machine, and id case-insensitively", () => {
		expect(filterHubSessions(SESSIONS, "FLAKY").map(s => s.id)).toEqual(["ses_b"]);
		expect(filterHubSessions(SESSIONS, "/srv").map(s => s.id)).toEqual(["ses_b"]);
		expect(filterHubSessions(SESSIONS, "dev-machine").map(s => s.id)).toEqual(["ses_a", "ses_c"]);
		expect(filterHubSessions(SESSIONS, "SES_B").map(s => s.id)).toEqual(["ses_b"]);
	});

	test("absent profile filters as default", () => {
		expect(filterHubSessions(SESSIONS, "default").map(s => s.id)).toEqual(["ses_a", "ses_c"]);
		expect(filterHubSessions(SESSIONS, "work").map(s => s.id)).toEqual(["ses_b"]);
	});

	test("no match yields an empty list", () => {
		expect(filterHubSessions(SESSIONS, "nope")).toEqual([]);
	});
});
