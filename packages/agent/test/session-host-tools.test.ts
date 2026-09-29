/**
 * Tool whitelists through the real session host (docs/protocol.md §2
 * `start.tools`, 0.9.0): a `start` config carrying `tools` must restrict the
 * SDK session to exactly those tools — `get-state.tools` reports the session's
 * effective top-level tool set, not a config echo. No model is needed; the
 * relay is an in-process WS stub: the host only needs the socket to open
 * before it reports ready.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

interface SpawnedHost {
	supervisor: Supervisor;
	ready: Promise<SessionReadyPayload>;
	exits: string[];
}

/** Real session host (no fixture) against a WS-stub relay; ready on socket open. */
async function spawnHost(
	id: string,
	project: string,
	relayPort: number,
	config: { tools?: string[] },
): Promise<SpawnedHost> {
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const exits: string[] = [];
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => exits.push(error),
			onExit: (_id, _code, reason) => exits.push(reason),
		},
		createLogger(`tools-host-test-${id}`),
		{ hostEntry: HOST_ENTRY },
	);
	await supervisor.spawn({ id, cwd: project, relayUrl: `ws://127.0.0.1:${relayPort}`, webUrl: "", ...config });
	return { supervisor, ready: ready.promise, exits };
}

/** WS stub relay + fresh project dir, shared by both scenarios. */
async function withRelay(run: (relayPort: number, project: string) => Promise<void>): Promise<void> {
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
	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-tools-host-"));
	const project = path.join(root, "project");
	await mkdir(project);
	try {
		await run(relay.port ?? 0, project);
	} finally {
		await relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}

/** `get-state.tools` from a live child; the whitelist's observation channel. */
async function toolsOf(supervisor: Supervisor, id: string): Promise<string[]> {
	const state = await supervisor.cmd(id, { reqId: `c_${id}`, cmd: "get-state" });
	expect(state.ok).toBe(true);
	const data = state.ok ? (state.data as { tools?: unknown }) : undefined;
	expect(Array.isArray(data?.tools)).toBe(true);
	return data?.tools as string[];
}

test("a tools whitelist restricts the session to exactly those tools", async () => {
	await withRelay(async (relayPort, project) => {
		const { supervisor, ready, exits } = await spawnHost("s_tools_wl", project, relayPort, {
			tools: ["bash", "read", "edit", "write"],
		});
		try {
			await ready;
			expect(exits).toEqual([]);
			// Exactly the whitelist, sorted: `restrictToolNames` replaces the whole
			// set (the default top level is larger), it does not filter a subset.
			expect(await toolsOf(supervisor, "s_tools_wl")).toEqual(["bash", "edit", "read", "write"]);
		} finally {
			await supervisor.stopAll("tools whitelist test done");
		}
	});
}, 120_000);

test("an unrestricted session keeps the default tool set", async () => {
	await withRelay(async (relayPort, project) => {
		const { supervisor, ready, exits } = await spawnHost("s_tools_open", project, relayPort, {});
		try {
			await ready;
			expect(exits).toEqual([]);
			const tools = await toolsOf(supervisor, "s_tools_open");
			// The default set is strictly larger than the pi-like four (grep/glob/
			// task/todo/... are top level), so the whitelist above is a real cut.
			expect(tools.length).toBeGreaterThan(4);
			expect(tools).toContain("grep");
			expect(tools).toContain("bash");
		} finally {
			await supervisor.stopAll("tools default test done");
		}
	});
}, 120_000);
