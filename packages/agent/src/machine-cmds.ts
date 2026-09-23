/**
 * Machine-level hub commands (docs/protocol.md §2 "Machine commands") — answered
 * by the daemon itself because they concern the machine, not a session child.
 * The `cmd` / `cmd-result` framing, `reqId` correlation, and hub-side timeout are
 * shared with session commands; a machine-level `cmd` simply carries no `id`.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errorMessage } from "./log";

/** One browsable child directory of the listing root. */
export interface DirEntry {
	name: string;
	path: string;
}

/** `list-dir` payload: the resolved directory, its parent, and child directories. */
export interface DirListing {
	/** Absolute, symlink-resolved directory this listing describes. */
	path: string;
	/** Parent directory, or null at the filesystem root. */
	parent: string | null;
	entries: DirEntry[];
	/** True when `entries` hit the cap and the machine has more children. */
	truncated: boolean;
}

/**
 * Upper bound on returned entries so a huge home directory cannot stall the
 * picker or the 15 s hub cmd budget (protocol §2).
 */
export const MAX_DIR_ENTRIES = 500;

/** Shape of the machine-level `cmd` frame the daemon accepts. */
export interface MachineCmdFrame {
	cmd: string;
	/** Directory to list; empty or missing lists the agent user's home. */
	path?: string;
}

export type MachineCmdResult = { ok: true; data: DirListing } | { ok: false; error: string };

/** Directory children only; symlinked directories are followed and included. */
async function listDirs(dir: string): Promise<DirEntry[]> {
	const dirents = await readdir(dir, { withFileTypes: true });
	const dirs: DirEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
		if (!dirent.isDirectory()) {
			try {
				// Broken symlink, or one that resolves to a file (e.g. /etc/localtime).
				if (!(await stat(path.join(dir, dirent.name))).isDirectory()) continue;
			} catch {
				continue;
			}
		}
		dirs.push({ name: dirent.name, path: path.join(dir, dirent.name) });
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
	return dirs;
}

/**
 * `list-dir`: resolve `rawPath` (default home) and return its directory
 * children. Symlink-resolving the target keeps breadcrumbs stable when the
 * browser sends back a path in unnormalized or aliased form.
 */
export async function listDirectories(rawPath: string | undefined, maxEntries = MAX_DIR_ENTRIES): Promise<DirListing> {
	const trimmed = rawPath?.trim();
	const target = await realpath(trimmed ? path.resolve(trimmed) : homedir());
	if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
	const entries = await listDirs(target);
	const truncated = entries.length > maxEntries;
	const root = path.parse(target).root;
	return {
		path: target,
		parent: target === root ? null : path.dirname(target),
		entries: truncated ? entries.slice(0, maxEntries) : entries,
		truncated,
	};
}

/**
 * Stable failure strings for common `list-dir` filesystem errors (protocol §2):
 * the hub maps these to client-error HTTP statuses, so they must stay
 * deterministic across platforms. Anything else keeps its raw message.
 */
function fsError(err: unknown): string {
	const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
	if (code === "ENOENT") return "no such directory";
	if (code === "ENOTDIR") return "not a directory";
	if (code === "EACCES" || code === "EPERM") return "permission denied";
	return errorMessage(err);
}

/** Routes one machine-level `cmd`; every path answers exactly once (protocol §2). */
export async function handleMachineCmd(frame: MachineCmdFrame): Promise<MachineCmdResult> {
	if (frame.cmd !== "list-dir") return { ok: false, error: `unknown machine command: ${frame.cmd}` };
	try {
		return { ok: true, data: await listDirectories(frame.path) };
	} catch (err) {
		return { ok: false, error: fsError(err) };
	}
}
