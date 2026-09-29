/**
 * omp profile name rules and discovery (docs/protocol.md §2 "Machine
 * commands"): the daemon mirrors `pi-utils/dirs` so hub-selected profiles
 * validate exactly like `omp --profile` and enumerate from
 * `~/.omp/profiles/<name>/agent`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { applyProfileSelection, defaultProfilesRoot, listProfiles, normalizeProfileName, profileExists, stripAmbientProfileEnv } from "../src/profiles";

test("normalizeProfileName mirrors omp --profile validation", () => {
	expect(normalizeProfileName(undefined)).toBeUndefined();
	expect(normalizeProfileName("")).toBeUndefined();
	expect(normalizeProfileName("  ")).toBeUndefined();
	expect(normalizeProfileName("default")).toBeUndefined();
	expect(normalizeProfileName(" work ")).toBe("work");
	expect(normalizeProfileName("a.b-c_d9")).toBe("a.b-c_d9");
	expect(normalizeProfileName("a".repeat(64))).toBe("a".repeat(64));

	expect(() => normalizeProfileName("a".repeat(65))).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName("Work")).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName(".hidden")).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName("trailing.")).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName("..")).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName("a b")).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName("con")).toThrow(/Invalid OMP profile/);
	expect(() => normalizeProfileName("CON.txt")).toThrow(/Invalid OMP profile/);
});

/** Profile root tree: two real profiles, a half-created dir, a bad name, a file. */
async function makeProfilesTree(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-profiles-list-"));
	await mkdir(path.join(root, "work", "agent"), { recursive: true });
	await mkdir(path.join(root, "personal", "agent"), { recursive: true });
	await mkdir(path.join(root, "half-created"), { recursive: true });
	await mkdir(path.join(root, "Upper", "agent"), { recursive: true });
	await writeFile(path.join(root, "notes.txt"), "x");
	return root;
}

test("listProfiles enumerates directories with an agent subdir, sorted", async () => {
	const root = await makeProfilesTree();
	try {
		expect(await listProfiles(root)).toEqual(["personal", "work"]);
		expect(await profileExists("work", root)).toBe(true);
		// No agent subdir yet: omp would create it on first use, the hub won't.
		expect(await profileExists("half-created", root)).toBe(false);
		expect(await profileExists("ghost", root)).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("listProfiles answers empty when the machine has no profile root", async () => {
	const missing = path.join(tmpdir(), `omp-hub-no-profiles-${process.pid}`);
	expect(await listProfiles(missing)).toEqual([]);
});

test("defaultProfilesRoot honors PI_CONFIG_DIR and defaults to .omp", () => {
	const original = process.env.PI_CONFIG_DIR;
	try {
		process.env.PI_CONFIG_DIR = ".omp-test";
		expect(defaultProfilesRoot().endsWith(path.join(".omp-test", "profiles"))).toBe(true);
		delete process.env.PI_CONFIG_DIR;
		expect(defaultProfilesRoot().endsWith(path.join(".omp", "profiles"))).toBe(true);
	} finally {
		if (original === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = original;
	}
});

test("applyProfileSelection strips the profile vars and the agent-dir override together", () => {
	// A lone PI_CODING_AGENT_DIR would hijack default mode (pi-utils honors it
	// without profile env), so a selection must remove all three or none.
	const env: Record<string, string | undefined> = {
		OMP_PROFILE: "glm",
		PI_PROFILE: "glm",
		PI_CODING_AGENT_DIR: "/home/x/.omp/profiles/glm/agent",
		PI_CONFIG_DIR: ".custom",
		HUB_TOKEN: "t",
	};
	applyProfileSelection(env, undefined);
	expect(env).toEqual({ PI_CONFIG_DIR: ".custom", HUB_TOKEN: "t" });

	applyProfileSelection(env, "work");
	expect(env).toEqual({
		PI_CONFIG_DIR: ".custom",
		HUB_TOKEN: "t",
		OMP_PROFILE: "work",
		PI_PROFILE: "work",
	});
});

test("stripAmbientProfileEnv removes ambient selection and reports what it removed", () => {
	const saved = { ...process.env };
	try {
		process.env.OMP_PROFILE = "glm";
		process.env.PI_PROFILE = "glm";
		process.env.PI_CODING_AGENT_DIR = "/home/x/.omp/profiles/glm/agent";

		const removed = stripAmbientProfileEnv();

		expect(removed).toEqual([
			"OMP_PROFILE=glm",
			"PI_PROFILE=glm",
			"PI_CODING_AGENT_DIR=/home/x/.omp/profiles/glm/agent",
		]);
		expect(process.env.OMP_PROFILE).toBeUndefined();
		expect(process.env.PI_PROFILE).toBeUndefined();
		expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();

		// A clean environment strips nothing.
		expect(stripAmbientProfileEnv()).toEqual([]);
	} finally {
		for (const key of ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR"] as const) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
});
