/**
 * Supervisor profile handling (docs/protocol.md §2 `start.profile`): a valid
 * profile reaches the session child as `OMP_PROFILE`/`PI_PROFILE`; an unknown
 * or syntactically invalid name fails the start through `onError` (the hub's
 * `session-error`) and never spawns a child.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const FIXTURE = new URL("./fixtures/profile-probe-child.ts", import.meta.url).pathname;

let root: string;
let profilesRoot: string;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-hub-supervisor-profile-"));
	profilesRoot = path.join(root, "profiles");
	await mkdir(path.join(profilesRoot, "work", "agent"), { recursive: true });
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Supervisor over the probe fixture, with the reported failure captured. */
function probeSupervisor(report: (error: string) => void, onReady?: (payload: SessionReadyPayload) => void): Supervisor {
	return new Supervisor(
		{
			onReady: (_id, payload) => onReady?.(payload),
			onError: (_id, error) => report(error),
			onExit: (_id, _code) => {},
		},
		createLogger("profile-test"),
		{ hostEntry: FIXTURE, profilesRoot },
	);
}

test("a valid profile reaches the child as OMP_PROFILE and PI_PROFILE", async () => {
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const supervisor = probeSupervisor(() => {}, payload => ready.resolve(payload));
	const reportPath = path.join(root, "env-report.json");
	await supervisor.spawn({
		id: "s_profile_ok",
		cwd: root,
		profile: "work",
		prompt: reportPath,
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	await ready.promise;

	// The fixture writes its env report before `ready`, so the file is complete.
	const report = JSON.parse(await readFile(reportPath, "utf8")) as {
		ompProfile: string | null;
		piProfile: string | null;
	};
	expect(report).toEqual({ ompProfile: "work", piProfile: "work" });
	await supervisor.stopAll("profile test done");
});

test("profile \"default\" is the implicit default: the child sees no profile env", async () => {
	// Even when the daemon itself runs under an ambient OMP_PROFILE, a hub start
	// selected as "default" must strip it — the web selection wins.
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const supervisor = probeSupervisor(() => {}, payload => ready.resolve(payload));
	const reportPath = path.join(root, "env-report-default.json");
	await supervisor.spawn({
		id: "s_profile_default",
		cwd: root,
		profile: "default",
		prompt: reportPath,
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	await ready.promise;

	const report = JSON.parse(await readFile(reportPath, "utf8")) as {
		ompProfile: string | null;
		piProfile: string | null;
	};
	expect(report).toEqual({ ompProfile: null, piProfile: null });
	await supervisor.stopAll("profile test done");
});

test("an unknown profile fails the start with a clear error and spawns no child", async () => {
	const errors: string[] = [];
	const supervisor = probeSupervisor(error => errors.push(error));
	await supervisor.spawn({
		id: "s_profile_missing",
		cwd: root,
		profile: "ghost",
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	expect(errors).toEqual(['profile "ghost" not found on this machine']);
	expect(supervisor.status()).toEqual([]);
});

test("a syntactically invalid profile fails the start with omp's validation error", async () => {
	const errors: string[] = [];
	const supervisor = probeSupervisor(error => errors.push(error));
	await supervisor.spawn({
		id: "s_profile_bad",
		cwd: root,
		profile: "Work..",
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	expect(errors[0]).toContain('Invalid OMP profile "Work.."');
	expect(supervisor.status()).toEqual([]);
});
