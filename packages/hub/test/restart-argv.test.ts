/**
 * Compiled-binary handling on the hub's upgrade-restart path
 * (`bun build --compile`): argv detection, re-exec argv, and the `--watch`
 * refusal — all driven by the virtual `$bunfs` entry path compiled binaries
 * report as `argv[1]`.
 */
import { describe, expect, test } from "bun:test";
import { isCompiledBinary, restartSpawnArgv } from "../src/server";

const EXEC = "/usr/local/bin/omp-hub";

describe("isCompiledBinary", () => {
	test("source runs (script path in argv[1]) are not compiled", () => {
		expect(isCompiledBinary(["/home/me/.local/bin/bun", "/srv/omp-hub/packages/hub/src/server.ts", "--watch"])).toBe(false);
		expect(isCompiledBinary(["bun", "src/server.ts"])).toBe(false);
	});

	test("compiled runs carry the virtual $bunfs entry", () => {
		expect(isCompiledBinary(["bun", "/$bunfs/root/omp-hub", "--port", "8471"])).toBe(true);
		expect(isCompiledBinary([EXEC, "/$bunfs/root/omp-hub"])).toBe(true);
	});

	test("an empty argv is not compiled", () => {
		expect(isCompiledBinary([])).toBe(false);
	});
});

describe("restartSpawnArgv", () => {
	test("source mode re-execs bun with the script and the user flags", () => {
		const argv = ["/home/me/.local/bin/bun", "/srv/omp-hub/packages/hub/src/server.ts", "--watch"];
		const spawned = restartSpawnArgv(argv);
		expect(spawned[0]).toBe(process.execPath);
		expect(spawned.slice(1)).toEqual(["/srv/omp-hub/packages/hub/src/server.ts", "--watch"]);
	});

	test("compiled mode drops the virtual entry, keeping execPath plus user flags", () => {
		const argv = ["bun", "/$bunfs/root/omp-hub", "--port", "8471"];
		const spawned = restartSpawnArgv(argv);
		expect(spawned[0]).toBe(process.execPath);
		// The $bunfs entry must never leak into the fresh process's argv: the
		// hub's own flag parsing would trip over it.
		expect(spawned).not.toContain("/$bunfs/root/omp-hub");
		expect(spawned.slice(1)).toEqual(["--port", "8471"]);
	});
});
