/**
 * Machine-level hub commands (docs/protocol.md §2 "Machine commands") — answered
 * by the daemon itself because they concern the machine, not a session child.
 * The `cmd` / `cmd-result` framing, `reqId` correlation, and hub-side timeout are
 * shared with session commands; a machine-level `cmd` simply carries no `id`.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type * as Sdk from "@oh-my-pi/pi-coding-agent";
import { errorMessage } from "./log";
import { defaultProfilesRoot, listProfiles } from "./profiles";

/**
 * The daemon's single, deliberately lazy SDK touchpoint: a broken install or
 * native binding must surface as a normal `cmd-result` error (protocol §2), not
 * kill the daemon at startup — and daemons on machines that never answer a
 * history command must not load it at all. Static imports cannot do either.
 */
async function loadSdk(): Promise<typeof Sdk> {
	return await import("@oh-my-pi/pi-coding-agent");
}

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

/** `list-profiles` payload: named omp profiles that exist on this machine. */
export interface ProfileListing {
	/** Valid profile names with an `agent` directory, sorted; `default` is implicit and never listed. */
	profiles: string[];
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
	/** Named omp profile the session belongs to; absent means the default profile. */
	profile?: string;
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
	/**
	 * `list-sessions` across every omp profile: the default profile plus each
	 * named profile merge into one recency-sorted listing whose entries carry
	 * `profile`; the 200 cap applies once. `cwd` is ignored in this mode.
	 */
	allProfiles?: boolean;
}

export type MachineCmdResult =
	{ ok: true; data: DirListing | ProfileListing | SessionListing }
	| { ok: false; error: string };

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

/** Wire shape for one scanned session, optionally stamped with its owning profile. */
function toEntry(entry: Sdk.SessionInfo, profile?: string): SessionListEntry {
	return {
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
		...(profile === undefined ? {} : { profile }),
	};
}

/**
 * `list-sessions`: recent sessions known to this machine's omp install, most
 * recently modified first.
 */
export async function listSessions(options: ListSessionsOptions = {}): Promise<SessionListing> {
	const maxEntries = options.maxEntries ?? MAX_SESSION_ENTRIES;
	const { SessionManager } = await loadSdk();
	const found = options.cwd
		? await SessionManager.listForPicker(options.cwd, options.sessionDir)
		: await SessionManager.listAllForPicker();
	// Picker results order pinned-first; a resume picker wants recency.
	const sorted = [...found].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const truncated = sorted.length > maxEntries;
	return {
		sessions: sorted.slice(0, maxEntries).map(entry => toEntry(entry)),
		truncated,
	};
}

export interface ListAllProfilesOptions {
	/** Profiles root override (tests); defaults to `~/$PI_CONFIG_DIR|.omp/profiles`. */
	profilesRoot?: string;
	/**
	 * Default-profile sessions root override (tests); unset uses the SDK's
	 * ambient resolution (`PI_CODING_AGENT_DIR`/XDG honored) via
	 * `SessionManager.listAllForPicker`.
	 */
	defaultSessionsRoot?: string;
	maxEntries?: number;
}

/**
 * `list-sessions` with `allProfiles`: the default profile's history plus every
 * named profile's (`<profilesRoot>/<name>/agent/sessions` — the same root the
 * supervisor validates starts against), merged most-recent-first and capped
 * once. Named-profile entries carry `profile`; the default profile's do not
 * (absent ⇒ default, like `start.profile`). Empty-stub filtering matches the
 * picker listing. When the daemon itself runs under a named profile, its
 * ambient "default" scan resolves to that profile's directory, so named scans
 * claim their paths first and the ambient scan only adds unseen files — rows
 * keep the profile that actually owns them instead of duplicating.
 */
export async function listAllProfileSessions(options: ListAllProfilesOptions = {}): Promise<SessionListing> {
	const maxEntries = options.maxEntries ?? MAX_SESSION_ENTRIES;
	const { SessionManager, FileSessionStorage, listAllSessions, filterSessionsForPicker } = await loadSdk();
	const storage = new FileSessionStorage();
	const root = options.profilesRoot ?? defaultProfilesRoot();
	const defaultFound = options.defaultSessionsRoot
		? filterSessionsForPicker(await listAllSessions(storage, options.defaultSessionsRoot), new Set())
		: await SessionManager.listAllForPicker(storage);
	const seen = new Set<string>();
	const merged: SessionListEntry[] = [];
	await Promise.all(
		(await listProfiles(root)).map(async profile => {
			const sessionsDir = path.join(root, profile, "agent", "sessions");
			for (const entry of filterSessionsForPicker(await listAllSessions(storage, sessionsDir), new Set())) {
				if (seen.has(entry.path)) continue;
				seen.add(entry.path);
				merged.push(toEntry(entry, profile));
			}
		}),
	);
	for (const entry of defaultFound) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		merged.push(toEntry(entry));
	}
	merged.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
	const truncated = merged.length > maxEntries;
	return { sessions: merged.slice(0, maxEntries), truncated };
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
	if (frame.cmd === "list-profiles") {
		try {
			return { ok: true, data: { profiles: await listProfiles() } };
		} catch (err) {
			return { ok: false, error: fsError(err) };
		}
	}
	if (frame.cmd === "list-sessions") {
		try {
			const data = frame.allProfiles ? await listAllProfileSessions() : await listSessions({ cwd: frame.cwd });
			return { ok: true, data };
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}
	return { ok: false, error: `unknown machine command: ${frame.cmd}` };
}
