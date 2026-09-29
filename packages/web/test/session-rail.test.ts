/**
 * `filterHubSessions` — the sidebar/quick-switcher filter: case-insensitive
 * substring match on name, cwd, machine, id, profile, namespace, or controller
 * (absent profile reads as "default", matching the resume picker).
 *
 * `diffSessionAlerts` / `alertText` — the bell's transition detection: an
 * `input` alert on the false→true `inputRequired` edge, a `completed` alert
 * on a live session's working→idle edge, an `exited` alert on any → exited;
 * brand-new records never alert.
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../src/hub/api";
import { filterHubSessions, railGlyphLabel } from "../src/hub/SessionRail";
import {
	alertText,
	alertsEnabled,
	completionsEnabled,
	diffSessionAlerts,
	setAlertsEnabled,
	setCompletionsEnabled,
	shouldSystemNotify,
} from "../src/hub/session-alerts";

function record(overrides: Partial<SessionRecord>): SessionRecord {
	return {
		id: "ses_a",
		machineId: "m1",
		machineName: "dev-machine",
		cwd: "/home/sky/omp-hub",
		name: "auth refactor",
		namespaceId: null,
		membershipVersion: 0,
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

	test("finds workers by namespace and current controller", () => {
		const worker = record({ id: "worker-1", namespaceId: "fleet-frontend", controllerId: "operator-1" });
		expect(filterHubSessions([...SESSIONS, worker], "FLEET-FRONTEND")).toEqual([worker]);
		expect(filterHubSessions([...SESSIONS, worker], "OPERATOR-1")).toEqual([worker]);
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
			// ses_c goes working→idle while still live: also a completion now.
			{ sessionId: "ses_c", sessionName: "docs", kind: "completed" },
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

	test("fires completed on a live session's working-to-idle edge", () => {
		const prev = [record({ activity: { working: true, inputRequired: false, updatedAt: 1 } })];
		const next = [record({ activity: { working: false, inputRequired: false, updatedAt: 2 } })];
		expect(diffSessionAlerts(prev, next)).toEqual([{ sessionId: "ses_a", sessionName: "auth refactor", kind: "completed" }]);
	});

	test("an input wait or an exit is never also a completion", () => {
		const prev = [
			record({ activity: { working: true, inputRequired: false, updatedAt: 1 } }),
			record({ id: "ses_b", name: "flaky test hunt", cwd: "/srv/api", activity: { working: true, inputRequired: false, updatedAt: 1 } }),
		];
		const next = [
			record({ activity: { working: false, inputRequired: true, updatedAt: 2 } }),
			record({ id: "ses_b", name: "flaky test hunt", cwd: "/srv/api", status: "exited", exitReason: "done" }),
		];
		expect(diffSessionAlerts(prev, next)).toEqual([
			{ sessionId: "ses_a", sessionName: "auth refactor", kind: "input" },
			{ sessionId: "ses_b", sessionName: "flaky test hunt", kind: "exited" },
		]);
	});
});

describe("alert delivery policy", () => {
	test("copy names the session and the transition", () => {
		const input = alertText({ sessionId: "s1", sessionName: "docs", kind: "input" });
		expect(input.title).toBe("docs needs input");
		const completed = alertText({ sessionId: "s1", sessionName: "docs", kind: "completed" });
		expect(completed.title).toBe("docs finished its task");
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

	test("the completion toggle persists through the guarded storage helpers", () => {
		setCompletionsEnabled(true);
		expect(completionsEnabled()).toBe(true);
		setCompletionsEnabled(false);
		expect(completionsEnabled()).toBe(false);
	});
});

describe("railGlyphLabel", () => {
	test("prefers the session title over the project directory", () => {
		expect(railGlyphLabel(record({ name: "fix parser bug", cwd: "/srv/omp/api" }))).toBe("F");
	});

	test("trims whitespace before taking the initial", () => {
		expect(railGlyphLabel(record({ name: "  flaky test hunt" }))).toBe("F");
	});

	test("falls back to the project directory for blank names", () => {
		expect(railGlyphLabel(record({ name: "   ", cwd: "/srv/omp/api" }))).toBe("A");
		expect(railGlyphLabel(record({ name: "", cwd: "/" }))).toBe("?");
	});
});
