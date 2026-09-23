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

/**
 * Upper bound on `list-sessions` rows: the resume picker only needs recent
 * history, and `listAllForPicker` scans every project's session directory.
 */
export const MAX_SESSION_ENTRIES = 200;

/** First-message preview kept to one short line per row. */
const FIRST_MESSAGE_CHARS = 240;

/** One resumable session on this machine (subset of the SDK's SessionInfo). */
export interface SessionListEntry {
	/** Absolute session file path; the value for a `start` frame's `sessionFile`. */
	path: string;
	id: string;
	/** Working directory recorded in the session header. */
	cwd: string;
	title?: string;
	created: string;
	modified: string;
	messageCount: number;
	/** Persisted assistant turns; zero means the agent never replied. */
	assistantTurns?: number;
	/** Coarse lifecycle status derived from the last persisted message. */
	status?: string;
	/** First user message, single line, truncated. */
	firstMessage: string;
}

/** `list-sessions` payload: most recently modified first. */
export interface SessionListing {
	sessions: SessionListEntry[];
	/** True when `sessions` hit the cap and older history exists. */
	truncated: boolean;
}

/** Shape of the machine-level `cmd` frame the daemon accepts. */
export interface MachineCmdFrame {
	cmd: string;
	/** Directory to list; empty or missing lists the agent user's home. */
	path?: string;
	/** `list-sessions` project filter; empty or missing lists every project. */
	cwd?: string;
}

export type MachineCmdResult = { ok: true; data: DirListing | SessionListing } | { ok: false; error: string };

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

/** Flatten text to one truncated line for single-row previews. */
function firstLine(text: string, maxChars: number): string {
	const line = text.split(/\r?\n/, 1)[0] ?? "";
	return line.length > maxChars ? `${line.slice(0, maxChars)}...` : line;
}

export interface ListSessionsOptions {
	/** Restrict the listing to the project `cwd` belongs to; omitted lists every project. */
	cwd?: string;
	/** Session directory override (tests); only meaningful with `cwd`. */
	sessionDir?: string;
	maxEntries?: number;
}

/**
 * `list-sessions`: recent sessions known to this machine's omp install, most
 * recently modified first. The SDK import is lazy — the daemon never touches it
 * otherwise, so native-binding or install failures surface as a normal
 * `cmd-result` error instead of a dead daemon.
 */
export async function listSessions(options: ListSessionsOptions = {}): Promise<SessionListing> {
	const maxEntries = options.maxEntries ?? MAX_SESSION_ENTRIES;
	const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
	const found = options.cwd
		? await SessionManager.listForPicker(options.cwd, options.sessionDir)
		: await SessionManager.listAllForPicker();
	// Picker results order pinned-first; a resume picker wants recency.
	const sorted = [...found].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const truncated = sorted.length > maxEntries;
	return {
		sessions: sorted.slice(0, maxEntries).map(entry => ({
			path: entry.path,
			id: entry.id,
			cwd: entry.cwd,
			...(entry.title ? { title: entry.title } : {}),
			created: entry.created.toISOString(),
			modified: entry.modified.toISOString(),
			messageCount: entry.messageCount,
			...(entry.assistantTurns === undefined ? {} : { assistantTurns: entry.assistantTurns }),
			...(entry.status === undefined ? {} : { status: entry.status }),
			firstMessage: firstLine(entry.firstMessage, FIRST_MESSAGE_CHARS),
		})),
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
	if (frame.cmd === "list-dir") {
		try {
			return { ok: true, data: await listDirectories(frame.path) };
		} catch (err) {
			return { ok: false, error: fsError(err) };
		}
	}
	if (frame.cmd === "list-sessions") {
		try {
			return { ok: true, data: await listSessions({ cwd: frame.cwd }) };
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}
	return { ok: false, error: `unknown machine command: ${frame.cmd}` };
}
