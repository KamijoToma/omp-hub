/**
 * `filterHubSessions` — the sidebar/quick-switcher filter: case-insensitive
 * substring match on name, cwd, machine, id, or profile (absent profile reads
 * as "default", matching the resume picker).
 *
 * `diffSessionAlerts` / `alertText` — the bell's transition detection: an
 * `input` alert on the false→true `inputRequired` edge, an `exited` alert on
 * any → exited; brand-new records never alert.
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/hub/api";
import { filterHubSessions } from "../src/hub/SessionSidebar";
import {
	alertText,
	alertsEnabled,
	diffSessionAlerts,
	setAlertsEnabled,
	shouldSystemNotify,
} from "../src/hub/session-alerts";

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
		expect(filterHubSessions(SESSIONS, "build-box").map(s => s.id)).toEqual(["ses_b"]);
		// One needle may hit different fields on different rows.
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

describe("diffSessionAlerts", () => {
	test("fires input on the rising edge and exited on any-to-exited", () => {
		const prev = [
			record({}),
			record({ id: "ses_b", name: "flaky test hunt", cwd: "/srv/api" }),
			record({ id: "ses_c", name: "docs", status: "live", activity: { working: true, inputRequired: false, updatedAt: 1 } }),
		];
		const next = [
			record({ activity: { working: true, inputRequired: true, updatedAt: 2 } }),
			record({ id: "ses_b", name: "flaky test hunt", cwd: "/srv/api", status: "exited", exitReason: "done" }),
			record({ id: "ses_c", name: "docs", status: "live", activity: { working: false, inputRequired: false, updatedAt: 2 } }),
		];
		expect(diffSessionAlerts(prev, next)).toEqual([
			{ sessionId: "ses_a", sessionName: "auth refactor", kind: "input" },
			{ sessionId: "ses_b", sessionName: "flaky test hunt", kind: "exited" },
		]);
	});

	test("steady input and brand-new records never alert", () => {
		const prev = [record({ activity: { working: false, inputRequired: true, updatedAt: 1 } })];
		const next = [record({ activity: { working: false, inputRequired: true, updatedAt: 2 } }), record({ id: "ses_new", name: "fresh" })];
		expect(diffSessionAlerts(prev, next)).toEqual([]);
	});

	test("removing input and an exited-to-exited poll are silent", () => {
		const prev = [record({ activity: { working: false, inputRequired: true, updatedAt: 1 } }), record({ id: "ses_d", name: "gone", status: "exited" })];
		const next = [record({}), record({ id: "ses_d", name: "gone", status: "exited", exitReason: "done" })];
		expect(diffSessionAlerts(prev, next)).toEqual([]);
	});
});

describe("alert delivery policy", () => {
	test("copy names the session and the transition", () => {
		const input = alertText({ sessionId: "s1", sessionName: "docs", kind: "input" });
		expect(input.title).toBe("docs needs input");
		const exited = alertText({ sessionId: "s1", sessionName: "docs", kind: "exited" });
		expect(exited.title).toBe("docs finished");
	});

	test("system notifications need permission and an off-screen session", () => {
		const alert: Parameters<typeof shouldSystemNotify>[0] = { sessionId: "s1", sessionName: "docs", kind: "input" };
		expect(shouldSystemNotify(alert, "s1", false, "granted")).toBe(false);
		expect(shouldSystemNotify(alert, "s1", true, "granted")).toBe(true);
		expect(shouldSystemNotify(alert, "s2", false, "granted")).toBe(true);
		expect(shouldSystemNotify(alert, "s2", false, "default")).toBe(false);
	});

	test("the toggle persists through the guarded storage helpers", () => {
		setAlertsEnabled(true);
		expect(alertsEnabled()).toBe(true);
		setAlertsEnabled(false);
		expect(alertsEnabled()).toBe(false);
	});
});
