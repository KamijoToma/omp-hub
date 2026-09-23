/**
 * Machine-level commands (docs/protocol.md §2 "Machine commands"): the daemon
 * answers `list-dir` itself — directories only, symlinked dirs included,
 * sorted, capped — and rejects everything it does not implement.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { handleMachineCmd, listAllProfileSessions, listDirectories, listSessions } from "../src/machine-cmds";

const NAME_ORDER = (a: string, b: string): number =>
	a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Tree: two plain dirs, a hidden dir, a file, a dir symlink, a file symlink, a broken symlink. */
async function makeTree(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-list-dir-"));
	await mkdir(path.join(root, "sub-a"));
	await mkdir(path.join(root, "Z-dir"));
	await mkdir(path.join(root, ".hiddendir"));
	await writeFile(path.join(root, "file.txt"), "x");
	await symlink(path.join(root, "sub-a"), path.join(root, "dir-link"));
	await writeFile(path.join(root, "link-target.txt"), "x");
	await symlink(path.join(root, "link-target.txt"), path.join(root, "file-link"));
	await symlink(path.join(root, "vanished"), path.join(root, "broken-link"));
	return root;
}

test("listDirectories returns directory children only, sorted, with parent navigation", async () => {
	const root = await makeTree();
	try {
		const listing = await listDirectories(root);
		const expected = [".hiddendir", "dir-link", "sub-a", "Z-dir"].sort(NAME_ORDER);
		expect(listing.entries.map(e => e.name)).toEqual(expected);
		// Entries carry absolute paths under the resolved root; the root itself
		// is realpath'd (macOS /tmp aliases) so children join onto it exactly.
		for (const entry of listing.entries) {
			expect(entry.path.startsWith(listing.path)).toBe(true);
			expect(path.basename(entry.path)).toBe(entry.name);
		}
		expect(listing.parent).toBe(path.dirname(listing.path));
		expect(listing.truncated).toBe(false);
		// The dir symlink lists the symlink path, not the resolved target.
		expect(listing.entries.find(e => e.name === "dir-link")?.path).toBe(path.join(listing.path, "dir-link"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listDirectories truncates at the entry cap and flags it", async () => {
	const root = await makeTree();
	try {
		for (let i = 0; i < 5; i++) await mkdir(path.join(root, `filler-${i}`));
		const listing = await listDirectories(root, 3);
		expect(listing.entries).toHaveLength(3);
		expect(listing.truncated).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listDirectories resolves symlinks, rejects files and missing paths, and stops at root", async () => {
	const root = await makeTree();
	try {
		// Symlink alias resolves to the real directory.
		const aliased = await listDirectories(path.join(root, "dir-link"));
		expect(aliased.path).toBe(await listDirectories(path.join(root, "sub-a")).then(l => l.path));

		// A file is not listable.
		expect(listDirectories(path.join(root, "file.txt"))).rejects.toThrow("not a directory");
		// Missing paths surface the filesystem error.
		expect(listDirectories(path.join(root, "vanished"))).rejects.toThrow();

		// The filesystem root has no parent to go up to.
		const rootListing = await listDirectories("/");
		expect(rootListing.parent).toBeNull();

		// No path lists the agent user's home.
		const home = await listDirectories(undefined);
		expect(home.path).toBe(await realpath(homedir()));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("handleMachineCmd answers list-dir and rejects unknown commands without throwing", async () => {
	const root = await makeTree();
	try {
		const ok = await handleMachineCmd({ cmd: "list-dir", path: root });
		expect(ok.ok).toBe(true);
		if (ok.ok && "entries" in ok.data) expect(ok.data.entries.length).toBeGreaterThan(0);

		const badPath = await handleMachineCmd({ cmd: "list-dir", path: path.join(root, "vanished") });
		expect(badPath).toEqual({ ok: false, error: "no such directory" });

		const fileDir = await handleMachineCmd({ cmd: "list-dir", path: path.join(root, "file.txt") });
		expect(fileDir).toEqual({ ok: false, error: "not a directory" });

		const unknown = await handleMachineCmd({ cmd: "reboot" });
		expect(unknown).toEqual({ ok: false, error: expect.stringContaining("unknown machine command: reboot") });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("handleMachineCmd answers list-profiles with a profile array", async () => {
	// The machine's real profile root is content this suite cannot pin; the
	// enumeration rules themselves are covered in profiles.test.ts. Here the
	// contract is the wire shape: ok, and `profiles` is a list.
	const result = await handleMachineCmd({ cmd: "list-profiles" });
	expect(result.ok).toBe(true);
	expect(result.ok && "profiles" in result.data && Array.isArray(result.data.profiles)).toBe(true);
});

/** One project dir + a session dir holding handcrafted omp session files. */
async function makeSessionFixtures(): Promise<{ project: string; sessionDir: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-list-sessions-"));
	const project = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	await mkdir(project);
	await mkdir(sessionDir);
	return { project, sessionDir };
}

interface FixtureOptions {
	id: string;
	title?: string;
	firstMessage?: string;
	/** Trailing newline-free second line to prove previews stay single-line. */
	multiline?: boolean;
}

/** Writes a minimal resumable session file (session header + one user/assistant turn). */
async function writeSession(sessionDir: string, project: string, options: FixtureOptions): Promise<string> {
	const lines = [
		...(options.title
			? [JSON.stringify({ type: "title", v: 1, title: options.title, updatedAt: "2026-06-27T00:00:00.000Z" })]
			: []),
		JSON.stringify({ type: "session", version: 3, id: options.id, timestamp: "2026-06-27T00:00:00.000Z", cwd: project }),
		...(options.firstMessage
			? [
					JSON.stringify({
						type: "message",
						message: { role: "user", content: options.multiline ? `${options.firstMessage}\nsecond line` : options.firstMessage },
					}),
					JSON.stringify({ type: "message", message: { role: "assistant", content: "done" } }),
				]
			: []),
	];
	const file = path.join(sessionDir, `20260627_${options.id}.jsonl`);
	await writeFile(file, `${lines.join("\n")}\n`);
	return file;
}

test("listSessions returns scoped history most-recent-first with single-line previews", async () => {
	const { project, sessionDir } = await makeSessionFixtures();
	try {
		const older = await writeSession(sessionDir, project, { id: "hista00001", firstMessage: "older prompt" });
		const newer = await writeSession(sessionDir, project, {
			id: "histb00001",
			title: "Fix the login bug",
			firstMessage: "first prompt",
			multiline: true,
		});
		// Distinct mtimes make the recency order deterministic.
		const early = new Date("2026-06-27T10:00:00.000Z");
		const late = new Date("2026-06-27T12:00:00.000Z");
		await utimes(older, early, early);
		await utimes(newer, late, late);

		const listing = await listSessions({ cwd: project, sessionDir });

		expect(listing.truncated).toBe(false);
		expect(listing.sessions.map(s => s.id)).toEqual(["histb00001", "hista00001"]);

		const [top, second] = listing.sessions;
		expect(top).toMatchObject({
			path: newer,
			id: "histb00001",
			cwd: project,
			title: "Fix the login bug",
			messageCount: 2,
		});
		expect(top.modified).toBe(late.toISOString());
		// The newline is flattened away so a row preview stays one line.
		expect(top.firstMessage).toBe("first prompt");
		expect(top.assistantTurns).toBeGreaterThan(0);
		expect(typeof top.status).toBe("string");
		expect(second).toMatchObject({ id: "hista00001", firstMessage: "older prompt" });
		expect(second.title).toBeUndefined();
	} finally {
		await rm(path.dirname(sessionDir), { recursive: true, force: true });
	}
});

test("listSessions truncates at the entry cap and flags it", async () => {
	const { project, sessionDir } = await makeSessionFixtures();
	try {
		await writeSession(sessionDir, project, { id: "hista00001", firstMessage: "a" });
		await writeSession(sessionDir, project, { id: "histb00001", firstMessage: "b" });

		const listing = await listSessions({ cwd: project, sessionDir, maxEntries: 1 });

		expect(listing.sessions).toHaveLength(1);
		expect(listing.truncated).toBe(true);
	} finally {
		await rm(path.dirname(sessionDir), { recursive: true, force: true });
	}
});

test("handleMachineCmd answers list-sessions; scopes without history list empty", async () => {
	const { project, sessionDir } = await makeSessionFixtures();
	try {
		await writeSession(sessionDir, project, { id: "hista00001", title: "titled session" });

		// Scoped dispatch without a sessionDir override derives the default
		// session dir from cwd — empty here, proving the scoping path answers.
		const scoped = await handleMachineCmd({ cmd: "list-sessions", cwd: project });
		expect(scoped).toEqual({ ok: true, data: { sessions: [], truncated: false } });

		// Preview long first messages are capped for the wire payload.
		const long = "x".repeat(400);
		await writeSession(sessionDir, project, { id: "histb00001", firstMessage: long });
		const listed = await listSessions({ cwd: project, sessionDir });
		expect(listed.sessions.find(s => s.id === "histb00001")?.firstMessage).toBe(`${"x".repeat(240)}...`);
	} finally {
		await rm(path.dirname(sessionDir), { recursive: true, force: true });
	}
});

/** All-profiles fixtures: a default sessions root plus `work` (with history) and `personal` (without). */
async function makeProfileFixtures(): Promise<{
	root: string;
	project: string;
	defaultRoot: string;
	profilesRoot: string;
}> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-profile-sessions-"));
	const project = path.join(root, "project");
	const defaultRoot = path.join(root, "default-sessions");
	const profilesRoot = path.join(root, "profiles");
	await mkdir(project);
	// listAllSessions globs `<root>/*/*.jsonl`, so each store gets a project bucket.
	await mkdir(path.join(defaultRoot, "proj"), { recursive: true });
	await mkdir(path.join(profilesRoot, "work", "agent", "sessions", "proj"), { recursive: true });
	// A profile whose session store does not exist yet contributes nothing.
	await mkdir(path.join(profilesRoot, "personal", "agent"), { recursive: true });
	return { root, project, defaultRoot, profilesRoot };
}

test("listAllProfileSessions merges every profile's history and stamps named entries", async () => {
	const { root, project, defaultRoot, profilesRoot } = await makeProfileFixtures();
	try {
		const older = await writeSession(path.join(defaultRoot, "proj"), project, {
			id: "defa00001",
			firstMessage: "older default",
		});
		const newer = await writeSession(path.join(defaultRoot, "proj"), project, {
			id: "defb00001",
			title: "default work",
			firstMessage: "newer default",
		});
		const newest = await writeSession(path.join(profilesRoot, "work", "agent", "sessions", "proj"), project, {
			id: "worka0001",
			title: "profile session",
			firstMessage: "work prompt",
		});
		const early = new Date("2026-06-27T08:00:00.000Z");
		const middle = new Date("2026-06-27T10:00:00.000Z");
		const late = new Date("2026-06-27T12:00:00.000Z");
		await utimes(older, early, early);
		await utimes(newer, middle, middle);
		await utimes(newest, late, late);

		const listing = await listAllProfileSessions({ profilesRoot, defaultSessionsRoot: defaultRoot });

		// One recency-sorted listing; named-profile rows carry `profile`,
		// default rows leave it absent (absent ⇒ default on the wire).
		expect(listing.truncated).toBe(false);
		expect(listing.sessions.map(s => [s.id, s.profile ?? "default"])).toEqual([
			["worka0001", "work"],
			["defb00001", "default"],
			["defa00001", "default"],
		]);
		expect(listing.sessions[0]).toMatchObject({ profile: "work", cwd: project, title: "profile session" });
		expect(listing.sessions[1]?.profile).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listAllProfileSessions caps the merged listing once", async () => {
	const { root, project, defaultRoot, profilesRoot } = await makeProfileFixtures();
	try {
		await writeSession(path.join(defaultRoot, "proj"), project, { id: "defa00001", firstMessage: "a" });
		await writeSession(path.join(defaultRoot, "proj"), project, { id: "defb00001", firstMessage: "b" });
		await writeSession(path.join(profilesRoot, "work", "agent", "sessions", "proj"), project, {
			id: "worka0001",
			firstMessage: "c",
		});

		const listing = await listAllProfileSessions({ profilesRoot, defaultSessionsRoot: defaultRoot, maxEntries: 2 });

		expect(listing.sessions).toHaveLength(2);
		expect(listing.truncated).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listAllProfileSessions does not duplicate the daemon's own profile directory", async () => {
	// A daemon started under a named profile scans that profile's store as its
	// ambient "default"; the named scan must skip the paths it already returned.
	const { root, project, profilesRoot } = await makeProfileFixtures();
	try {
		await mkdir(path.join(profilesRoot, "self", "agent", "sessions", "proj"), { recursive: true });
		await writeSession(path.join(profilesRoot, "self", "agent", "sessions", "proj"), project, {
			id: "selfa0001",
			title: "own profile session",
			firstMessage: "x",
		});

		const listing = await listAllProfileSessions({
			profilesRoot,
			defaultSessionsRoot: path.join(profilesRoot, "self", "agent", "sessions"),
		});

		// The named scan claims the directory first, so the row is stamped
		// with the profile that owns it and never appears twice.
		expect(listing.sessions.map(s => [s.id, s.profile ?? "default"])).toEqual([["selfa0001", "self"]]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
