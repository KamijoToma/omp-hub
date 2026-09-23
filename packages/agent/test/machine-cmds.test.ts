/**
 * Machine-level commands (docs/protocol.md §2 "Machine commands"): the daemon
 * answers `list-dir` itself — directories only, symlinked dirs included,
 * sorted, capped — and rejects everything it does not implement.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { handleMachineCmd, listDirectories } from "../src/machine-cmds";

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
		if (ok.ok) expect(ok.data.entries.length).toBeGreaterThan(0);

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
