/**
 * Machine-level commands (docs/protocol.md §2 "Machine commands"): the daemon
 * answers `list-dir` itself — directories only, symlinked dirs included,
 * sorted, capped — and rejects everything it does not implement.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { handleMachineCmd, listAllProfileSessions, listDirectories, listSessions, type SessionSearchResults } from "../src/machine-cmds";

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
async function makeSessionFixtures(): Promise<{ root: string; project: string; sessionDir: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-list-sessions-"));
	const project = path.join(root, "project");
	// Nested as `<root>/agent/sessions` so search-sessions' session-store path
	// guard accepts the fixtures (docs/protocol.md §2).
	const sessionDir = path.join(root, "agent", "sessions");
	await mkdir(project);
	await mkdir(sessionDir, { recursive: true });
	return { root, project, sessionDir };
}

interface FixtureOptions {
	id: string;
	title?: string;
	firstMessage?: string;
	/** Trailing newline-free second line to prove previews stay single-line. */
	multiline?: boolean;
	/** User/assistant turn pairs (default 1 when `firstMessage` is set). */
	turns?: number;
	/** Filler bytes appended to the first user prompt, pushing later entries past the SDK's 4 KB scan window. */
	padBytes?: number;
	/** Assistant reply of the final turn (default `"done"`). */
	assistantMessage?: string;
}

/** Writes a resumable session file (session header + N user/assistant turns). */
async function writeSession(sessionDir: string, project: string, options: FixtureOptions): Promise<string> {
	const lines = [
		...(options.title
			? [JSON.stringify({ type: "title", v: 1, title: options.title, updatedAt: "2026-06-27T00:00:00.000Z" })]
			: []),
		JSON.stringify({ type: "session", version: 3, id: options.id, timestamp: "2026-06-27T00:00:00.000Z", cwd: project }),
	];
	const turns = options.firstMessage ? (options.turns ?? 1) : 0;
	for (let i = 0; i < turns; i++) {
		const base = i === 0 ? (options.firstMessage ?? "") : `turn ${i}`;
		// Padding rides on EVERY prompt: the whole file must outgrow the SDK
		// scan's 4096-byte window, not just its first entry.
		const content = options.padBytes ? base + "x".repeat(options.padBytes) : base;
		const reply = i === turns - 1 && options.assistantMessage !== undefined ? options.assistantMessage : "done";
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "user", content: options.multiline && i === 0 ? `${content}\nsecond line` : content },
			}),
			JSON.stringify({ type: "message", message: { role: "assistant", content: reply } }),
		);
	}
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

test("listSessions reports the exact message count beyond the picker's 4 KB window", async () => {
	const { project, sessionDir } = await makeSessionFixtures();
	try {
		// 8 turns × (user + assistant), each prompt padded so the SDK picker
		// scan's 4096-byte window covers only the first ~2 entries. That window
		// is where the old count came from: every real session reported 2-3.
		await writeSession(sessionDir, project, {
			id: "histbig001",
			firstMessage: "big history",
			turns: 8,
			padBytes: 1500,
		});

		const listing = await listSessions({ cwd: project, sessionDir });
		expect(listing.sessions).toHaveLength(1);
		expect(listing.sessions[0]!.messageCount).toBe(16);
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
		expect(listing.sessions[0]).toMatchObject({ profile: "work", cwd: project, title: "profile session", messageCount: 2 });
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

test("search-sessions matches user and assistant text case-insensitively with a snippet", async () => {
	const { root, project, sessionDir } = await makeSessionFixtures();
	try {
		const promptHit = await writeSession(sessionDir, project, { id: "srcha00001", firstMessage: "Fork the repo" });
		const assistantHit = await writeSession(sessionDir, project, {
			id: "srchb0002",
			firstMessage: "anything",
			assistantMessage: "Deployed to production successfully",
		});
		const miss = await writeSession(sessionDir, project, { id: "srchc0003", firstMessage: "unrelated prompt" });

		const prompts = await handleMachineCmd({ cmd: "search-sessions", paths: [promptHit, miss], query: "  FORK " });
		expect(prompts.ok).toBe(true);
		if (prompts.ok) {
			const { results } = prompts.data as SessionSearchResults;
			expect(results).toEqual([{ path: promptHit, count: 1, snippet: "Fork the repo" }]);
		}

		const assistant = await handleMachineCmd({ cmd: "search-sessions", paths: [promptHit, assistantHit], query: "PRODUCTION" });
		expect(assistant.ok).toBe(true);
		if (assistant.ok) {
			const { results } = assistant.data as SessionSearchResults;
			// Request order, and thinking/tool blocks never match.
			expect(results).toEqual([{ path: assistantHit, count: 1, snippet: "Deployed to production successfully" }]);
		}
	} finally {
		await rm(path.dirname(path.dirname(sessionDir)), { recursive: true, force: true });
	}
});

test("search-sessions counts every matching message and flattens multiline snippets", async () => {
	const { root, project, sessionDir } = await makeSessionFixtures();
	try {
		const file = await writeSession(sessionDir, project, {
			id: "srchd0004",
			firstMessage: "alpha",
			multiline: true,
			turns: 3,
		});

		const counted = await handleMachineCmd({ cmd: "search-sessions", paths: [file], query: "turn" });
		expect(counted.ok).toBe(true);
		if (counted.ok) {
			const { results } = counted.data as SessionSearchResults;
			// "turn 1" and "turn 2" both match; the first prompt does not.
			expect(results).toHaveLength(1);
			expect(results[0]?.count).toBe(2);
		}

		const flattened = await handleMachineCmd({ cmd: "search-sessions", paths: [file], query: "second line" });
		expect(flattened.ok).toBe(true);
		if (flattened.ok) {
			const { results } = flattened.data as SessionSearchResults;
			expect(results[0]?.snippet).toBe("alpha second line");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("search-sessions validates input and skips paths outside an omp session store", async () => {
	const { root, project, sessionDir } = await makeSessionFixtures();
	try {
		const inside = await writeSession(sessionDir, project, { id: "srche0005", firstMessage: "needle here" });
		// A real, readable session-shaped file outside any `agent/sessions` store.
		const outside = path.join(project, "escaped.jsonl");
		await writeFile(outside, `${JSON.stringify({ type: "message", message: { role: "user", content: "needle here" } })}\n`);

		expect((await handleMachineCmd({ cmd: "search-sessions", query: "needle" })).ok).toBe(false);
		expect((await handleMachineCmd({ cmd: "search-sessions", query: "   " })).ok).toBe(false);
		// The wire is untrusted despite the frame type: a non-string path entry.
		const badFrame = { cmd: "search-sessions", query: "needle", paths: [inside, 42] } as unknown as Parameters<typeof handleMachineCmd>[0];
		expect((await handleMachineCmd(badFrame)).ok).toBe(false);
		expect(
			(await handleMachineCmd({
				cmd: "search-sessions",
				query: "needle",
				// Post-dedupe cap: the bound is on files scanned, not entries sent.
				paths: Array.from({ length: 201 }, (_, i) => `/tmp/never/${i}.jsonl`),
			})).ok,
		).toBe(false);

		// Unresolvable and non-store paths are skipped silently, never errors.
		const skipped = await handleMachineCmd({ cmd: "search-sessions", paths: [outside, "/nonexistent/a.jsonl"], query: "needle" });
		expect(skipped.ok).toBe(true);
		if (skipped.ok) {
			const { results } = skipped.data as SessionSearchResults;
			expect(results).toEqual([]);
		}

		const hit = await handleMachineCmd({ cmd: "search-sessions", paths: [inside, outside], query: "needle" });
		expect(hit.ok).toBe(true);
		if (hit.ok) {
			const { results } = hit.data as SessionSearchResults;
			expect(results).toEqual([{ path: inside, count: 1, snippet: "needle here" }]);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
