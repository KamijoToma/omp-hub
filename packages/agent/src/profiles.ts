/**
 * omp profile discovery and validation (docs/protocol.md §2 "Machine commands").
 *
 * A named omp profile isolates agent state under `~/.omp/profiles/<name>/agent`
 * (config, auth, skills, sessions); the SDK derives the same path in
 * `pi-utils/dirs.ts` and activates it from `OMP_PROFILE`/`PI_PROFILE` at module
 * load. The daemon never imports the SDK, so the rules are mirrored here:
 * `PI_CONFIG_DIR` overrides the config dir name and profile names must pass
 * omp's own charset/platform rules. Activation itself is the supervisor's job —
 * it exports the env vars on the session child.
 */

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** omp profile charset (pi-utils `PROFILE_NAME_RE`). */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Windows reserves these device names as basenames and `NAME.<anything>`
 * (pi-utils `WINDOWS_RESERVED_BASENAME_RE`); matching omp keeps daemon-side
 * rejection identical to `--profile` validation.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Validate `raw` as a selectable profile name. `"default"` and blank mean the
 * implicit default profile (`undefined`); anything else must match omp's name
 * rules, and a violation throws with omp's message shape so hub users see the
 * same explanation `--profile` would give.
 */
export function normalizeProfileName(raw: string | undefined): string | undefined {
	const normalized = raw?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${raw}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name.`,
		);
	}
	return normalized;
}

/** Profile roots live at `<configRoot>/profiles`; `PI_CONFIG_DIR` renames `.omp`. */
export function defaultProfilesRoot(): string {
	const configDir = process.env.PI_CONFIG_DIR?.trim() || ".omp";
	return path.join(homedir(), configDir, "profiles");
}

/**
 * Named profiles that exist on this machine: subdirectories of the profile
 * root that contain an `agent` directory (omp creates it on first use), sorted
 * for display. A missing root simply means the machine has no profiles yet;
 * names that fail omp's rules are skipped so stray directories never surface.
 */
export async function listProfiles(root: string = defaultProfilesRoot()): Promise<string[]> {
	let dirents: Dirent[];
	try {
		dirents = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const profiles: string[] = [];
	for (const dirent of dirents) {
		if (!PROFILE_NAME_RE.test(dirent.name) || !dirent.isDirectory()) continue;
		try {
			if (!(await stat(path.join(root, dirent.name, "agent"))).isDirectory()) continue;
		} catch {
			continue;
		}
		profiles.push(dirent.name);
	}
	return profiles.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

/**
 * Whether `name` names an existing profile on this machine (its `agent`
 * directory exists). omp creates a profile on first `--profile` use, but the
 * hub starts sessions with `autoApprove: true` against whatever credentials
 * that profile carries — a typo must fail the start, not silently mint an
 * empty profile.
 */
export async function profileExists(name: string, root: string = defaultProfilesRoot()): Promise<boolean> {
	try {
		return (await stat(path.join(root, name, "agent"))).isDirectory();
	} catch {
		return false;
	}
}
