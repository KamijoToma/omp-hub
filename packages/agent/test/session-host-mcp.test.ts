/**
 * MCP management commands against the real session host (docs/protocol.md §2
 * `mcp-*`): config add/remove/enable/list round-trip the user and project
 * `mcp.json` files the SDK discovery reads, and secrets (env values, tokens,
 * URL queries) never ride the reply. The child runs under an isolated `HOME`
 * (the supervisor strips profile-selecting env, so the agent dir cannot be
 * redirected that way), keeping user- and project-scope configs out of the
 * real `~/.omp`. The relay is an in-process WS stub; the live session starts
 * with no servers configured, so `mcp-list` rows carry no live section until
 * the configs exist — which is exactly the "apply on restart" story the modal
 * tells.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

interface CommandOutcome {
	ok: boolean;
	data?: unknown;
	error?: string;
}

function configOf(root: string, scope: "user" | "project"): string {
	return scope === "user"
		? path.join(root, "home", ".omp", "agent", "mcp.json")
		: path.join(root, "project", ".omp", "mcp.json");
}

test("session host manages MCP server config via mcp-* commands", async () => {
	const relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 })),
		websocket: {
			open() {},
			message() {},
			close() {},
		},
	});

	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-mcp-host-"));
	const agentDir = path.join(root, "home", ".omp", "agent");
	await mkdir(path.join(root, "project"), { recursive: true });
	await mkdir(agentDir, { recursive: true });

	// The supervisor strips profile-selecting env (OMP_PROFILE/PI_PROFILE/
	// PI_CODING_AGENT_DIR) from every child by design, so the child's agent dir
	// cannot be redirected through the environment. Isolate the child's home
	// instead: pi-utils resolves every dir-affecting path (user-scope
	// `getMCPConfigPath("user")` included) under this HOME, and the spawn
	// config's explicit agentDir points at the same directory.
	const savedHome = process.env.HOME;
	process.env.HOME = path.join(root, "home");

	const ready = Promise.withResolvers<SessionReadyPayload>();
	const exits: string[] = [];
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => exits.push(error),
			onExit: (_id, _code, reason) => exits.push(reason),
		},
		createLogger("mcp-host-test"),
		{ hostEntry: HOST_ENTRY },
	);

	try {
		await supervisor.spawn({
			id: "s_mcp001",
			cwd: path.join(root, "project"),
			agentDir,
			relayUrl: `ws://127.0.0.1:${relay.port}`,
			webUrl: "",
		});
		await ready.promise;
		expect(exits).toEqual([]);

		const cmd = (reqId: string, frame: Record<string, unknown>): Promise<CommandOutcome> =>
			supervisor.cmd("s_mcp001", { reqId, cmd: "", ...frame }) as Promise<CommandOutcome>;

		// Empty configs list empty.
		const empty = await cmd("c_mcp01", { cmd: "mcp-list" });
		expect(empty.ok).toBe(true);
		expect(empty.data).toEqual({ servers: [] });

		// Seed configs directly: a user stdio server with env values and a
		// key-carrying URL query, plus a shadowing project entry and a
		// project-only http server with a bearer token.
		await mkdir(path.join(root, "project", ".omp"), { recursive: true });
		await writeFile(
			configOf(root, "user"),
			JSON.stringify({
				mcpServers: {
					shared: { type: "stdio", command: "user-runner", args: ["--user"], env: { SECRET: "hunter2" } },
					useronly: { type: "http", url: "https://api.example.dev/v1?key=k123", enabled: false },
				},
			}),
		);
		await writeFile(
			configOf(root, "project"),
			JSON.stringify({
				mcpServers: {
					shared: { type: "stdio", command: "project-runner" },
					projonly: { type: "sse", url: "https://sse.example.dev/mcp?token=t9" },
				},
			}),
		);

		const listed = await cmd("c_mcp02", { cmd: "mcp-list" });
		expect(listed.ok).toBe(true);
		const servers = (listed.data as { servers: Array<Record<string, unknown>> }).servers;
		const row = (name: string, scope?: string): Record<string, unknown> => {
			const found = servers.filter(entry => entry.name === name && (scope === undefined || entry.scope === scope));
			expect(found).toHaveLength(1);
			return found[0]!;
		};
		expect(servers).toHaveLength(4);

		// User rows first, project shadow marked; the shadow row does NOT claim
		// the live connection of the winner.
		const sharedUser = row("shared", "user");
		expect(sharedUser).toMatchObject({ scope: "user", type: "stdio", shadowed: true, location: "user-runner" });
		const sharedProject = row("shared", "project");
		expect(sharedProject.scope).toBe("project");
		expect("shadowed" in sharedProject).toBe(false);

		// Redaction: URL queries and env values never ride the reply.
		const useronly = row("useronly");
		expect(useronly).toMatchObject({ scope: "user", type: "http", enabled: false, location: "https://api.example.dev/v1" });
		expect(JSON.stringify(useronly)).not.toContain("k123");
		const projonly = row("projonly");
		expect(projonly).toMatchObject({ scope: "project", type: "sse", enabled: true, location: "https://sse.example.dev/mcp" });
		expect(JSON.stringify(projonly)).not.toContain("t9");
		expect(JSON.stringify(sharedUser)).not.toContain("hunter2");
		expect(sharedUser.envCount).toBe(1);

		// mcp-add (stdio): persisted to the project file, args preserved.
		const added = await cmd("c_mcp03", { cmd: "mcp-add", name: "localtools", command: "bun", args: ["run", "mcp"] });
		expect(added.ok).toBe(true);
		expect(added.data).toEqual({ name: "localtools", scope: "project" });
		const projectFile = JSON.parse(await readFile(configOf(root, "project"), "utf8"));
		expect(projectFile.mcpServers.localtools).toEqual({ type: "stdio", command: "bun", args: ["run", "mcp"] });

		// Duplicate add fails with the writer's own message.
		const duplicate = await cmd("c_mcp04", { cmd: "mcp-add", name: "localtools", command: "bun" });
		expect(duplicate.ok).toBe(false);
		expect(duplicate.error).toContain("already exists");

		// mcp-add (remote + token): the token lands only in the file's
		// Authorization header, never in the reply.
		const remote = await cmd("c_mcp05", {
			cmd: "mcp-add",
			name: "cloudapi",
			scope: "user",
			url: "cloud.example.net/mcp",
			transport: "sse",
			token: "shh",
		});
		expect(remote.ok).toBe(true);
		expect(JSON.stringify(remote.data)).not.toContain("shh");
		const userFile = JSON.parse(await readFile(configOf(root, "user"), "utf8"));
		expect(userFile.mcpServers.cloudapi).toEqual({
			type: "sse",
			url: "https://cloud.example.net/mcp",
			headers: { Authorization: "Bearer shh" },
		});

		// mcp-add validation failures never touch the files.
		for (const [index, frame] of [
			{ cmd: "mcp-add", name: "bad", command: "a", url: "https://x.dev" },
			{ cmd: "mcp-add", name: "bad", token: "t" },
			{ cmd: "mcp-add", name: "bad", url: "https://x.dev", transport: "ws" },
			{ cmd: "mcp-add", name: "bad", command: "a", args: ["ok", 3] },
			{ cmd: "mcp-add", name: "bad", scope: "global", command: "a" },
		].entries()) {
			const bad = await cmd(`c_mcp06_${index}`, frame);
			expect(bad.ok).toBe(false);
		}
		const afterBad = JSON.parse(await readFile(configOf(root, "project"), "utf8"));
		expect(afterBad.mcpServers.bad).toBeUndefined();

		// mcp-set-enabled: project entry updated in place.
		const projectOff = await cmd("c_mcp07", { cmd: "mcp-set-enabled", name: "localtools", enabled: false });
		expect(projectOff.ok).toBe(true);
		expect(projectOff.data).toEqual({ name: "localtools", enabled: false, where: "project" });
		expect(JSON.parse(await readFile(configOf(root, "project"), "utf8")).mcpServers.localtools.enabled).toBe(false);

		// User entry next; then the disabled-list fallback for a name with no
		// config entry (disable adds it, enable removes it).
		const userOff = await cmd("c_mcp08", { cmd: "mcp-set-enabled", name: "cloudapi", enabled: false });
		expect(userOff.data).toEqual({ name: "cloudapi", enabled: false, where: "user" });
		const listedOff = await cmd("c_mcp09", { cmd: "mcp-list" });
		const cloudRow = (listedOff.data as { servers: Array<Record<string, unknown>> }).servers.find(
			row => row.name === "cloudapi",
		);
		expect(cloudRow).toMatchObject({ enabled: false });

		const listDisable = await cmd("c_mcp11", { cmd: "mcp-set-enabled", name: "ghost", enabled: false });
		expect(listDisable.data).toEqual({ name: "ghost", enabled: false, where: "disabled-list" });
		expect(JSON.parse(await readFile(configOf(root, "user"), "utf8")).disabledServers).toEqual(["ghost"]);
		const listEnable = await cmd("c_mcp12", { cmd: "mcp-set-enabled", name: "ghost", enabled: true });
		expect(listEnable.data).toEqual({ name: "ghost", enabled: true, where: "disabled-list" });
		expect(JSON.parse(await readFile(configOf(root, "user"), "utf8")).disabledServers).toBeUndefined();

		// Enabling a name that exists nowhere fails.
		const unknownEnable = await cmd("c_mcp13", { cmd: "mcp-set-enabled", name: "ghost", enabled: true });
		expect(unknownEnable.ok).toBe(false);
		expect(unknownEnable.error).toContain("not found");

		// mcp-test: unknown server refuses before any connection attempt.
		const unknownTest = await cmd("c_mcp14", { cmd: "mcp-test", name: "nosuch" });
		expect(unknownTest.ok).toBe(false);
		expect(unknownTest.error).toContain("not found or disabled");

		// mcp-test: a stdio command that dies immediately fails the connection
		// instead of hanging the cmd budget.
		const deadAdd = await cmd("c_mcp15", {
			cmd: "mcp-add",
			name: "deadserver",
			command: "bun",
			args: [path.join(root, "does-not-exist.ts")],
		});
		expect(deadAdd.ok).toBe(true);
		const deadTest = await cmd("c_mcp16", { cmd: "mcp-test", name: "deadserver" });
		expect(deadTest.ok).toBe(false);

		// mcp-remove: gone from the file; a second remove fails.
		const removed = await cmd("c_mcp17", { cmd: "mcp-remove", name: "localtools", scope: "project" });
		expect(removed.ok).toBe(true);
		expect(removed.data).toEqual({ name: "localtools", scope: "project" });
		expect(JSON.parse(await readFile(configOf(root, "project"), "utf8")).mcpServers.localtools).toBeUndefined();
		const reRemoved = await cmd("c_mcp18", { cmd: "mcp-remove", name: "localtools", scope: "project" });
		expect(reRemoved.ok).toBe(false);

		// The host survives every failure above.
		const alive = await cmd("c_mcp19", { cmd: "get-state" });
		expect(alive.ok).toBe(true);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		await supervisor.stopAll("mcp test done");
		relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
