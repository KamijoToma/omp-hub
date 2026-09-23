import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	classifyChangedPaths,
	findActiveSessions,
	rollbackWebDist,
	switchWebDist,
} from "../src/deploy-demo";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("demo deployment planning", () => {
	test("classifies runtime paths and ignores operational documentation and tests", () => {
		expect(classifyChangedPaths(["packages/web/src/main.tsx"])).toEqual({ web: true, hub: false, agent: false });
		expect(classifyChangedPaths(["packages/hub/src/server.ts", "packages/agent/src/main.ts"])).toEqual({
			web: false,
			hub: true,
			agent: true,
		});
		expect(
			classifyChangedPaths([
				"README.md",
				"docs/architecture.md",
				"packages/hub/test/api.test.ts",
				"packages/hub/src/deploy-demo.ts",
			]),
		).toEqual({ web: false, hub: false, agent: false });
	});

	test("deploys every component for an unknown future shared runtime path", () => {
		expect(classifyChangedPaths(["shared/protocol.ts"])).toEqual({ web: true, hub: true, agent: true });
	});

	test("only starting and live sessions block a disruptive deployment", () => {
		expect(
			findActiveSessions({
				sessions: [
					{ id: "s-start", name: "starting", status: "starting" },
					{ id: "s-live", name: "live", status: "live" },
					{ id: "s-exit", name: "exited", status: "exited" },
					{ id: "s-fail", name: "failed", status: "failed" },
				],
			}),
		).toEqual([
			{ id: "s-start", name: "starting", status: "starting" },
			{ id: "s-live", name: "live", status: "live" },
		]);
	});

	test("rejects malformed session payloads instead of assuming the demo is idle", () => {
		expect(() => findActiveSessions({ sessions: [{ id: "s-bad", status: "live" }] })).toThrow(
			"/api/sessions returned a malformed session",
		);
	});
});

describe("atomic web distribution switch", () => {
	test("switches and restores an existing release symlink", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-hub-deploy-"));
		temporaryRoots.push(root);
		const releaseA = path.join(root, "releases/a");
		const releaseB = path.join(root, "releases/b");
		const dist = path.join(root, "web/dist");
		await mkdir(releaseA, { recursive: true });
		await mkdir(releaseB, { recursive: true });
		await mkdir(path.dirname(dist), { recursive: true });
		await symlink(path.relative(path.dirname(dist), releaseA), dist, "dir");

		const change = await switchWebDist(dist, releaseB, path.join(root, "backups"));
		expect(path.resolve(path.dirname(dist), await readlink(dist))).toBe(releaseB);

		await rollbackWebDist(change);
		expect(path.resolve(path.dirname(dist), await readlink(dist))).toBe(releaseA);
	});

	test("migrates a legacy directory and can restore it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-hub-deploy-"));
		temporaryRoots.push(root);
		const release = path.join(root, "releases/new");
		const dist = path.join(root, "web/dist");
		await mkdir(release, { recursive: true });
		await mkdir(dist, { recursive: true });
		await writeFile(path.join(dist, "legacy.txt"), "legacy");

		const change = await switchWebDist(dist, release, path.join(root, "backups"));
		expect((await lstat(dist)).isSymbolicLink()).toBe(true);
		expect(path.resolve(path.dirname(dist), await readlink(dist))).toBe(release);

		await rollbackWebDist(change);
		expect((await lstat(dist)).isDirectory()).toBe(true);
		expect(await readFile(path.join(dist, "legacy.txt"), "utf8")).toBe("legacy");
	});
});
