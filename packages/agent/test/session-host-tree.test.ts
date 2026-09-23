/**
 * `get-tree` against the real session host (docs/protocol.md §2 SessionTree):
 * a resumed fixture file with a branch point and non-wire `custom` entries
 * must come back as a preview-only tree — pruned entries re-homed, the active
 * leaf path marked, no message bodies. The relay is an in-process WS stub: the
 * host only needs the socket to open before it reports ready.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

interface TreeWireNode {
	id: string;
	parentId: string | null;
	type: string;
	role?: string;
	synthetic?: true;
	toolName?: string;
	customType?: string;
	preview: string;
	timestamp: string;
	label?: string;
	branch?: true;
	leaf?: true;
	children: TreeWireNode[];
}

interface TreePayload {
	leafId: string | null;
	truncated: boolean;
	nodes: TreeWireNode[];
}

test("session host answers get-tree with a pruned, branch-marked preview tree", async () => {
	// Any WS upgrade passes: CollabHost.start resolves on socket open.
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

	const root = await mkdtemp(path.join(tmpdir(), "omp-hub-tree-host-"));
	const project = path.join(root, "project");
	await mkdir(project);
	const sessionFile = path.join(root, "20260627_treeget01.jsonl");
	const t = (n: number): string => `2026-06-27T00:00:0${n}.000Z`;
	// e_hud/e_hud2 are non-wire `custom` entries: the web never sees them, so
	// get-tree must re-home their children (e_u2 → e_a1, e_a2 → e_u2).
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "treeget01", timestamp: t(0), cwd: project }),
		JSON.stringify({ type: "message", id: "e_u1", parentId: null, timestamp: t(1), message: { role: "user", content: "first prompt" } }),
		JSON.stringify({ type: "message", id: "e_a1", parentId: "e_u1", timestamp: t(2), message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
		JSON.stringify({ type: "custom", id: "e_hud", parentId: "e_a1", timestamp: t(3), customType: "todo_hud_state", data: {} }),
		JSON.stringify({ type: "message", id: "e_u2", parentId: "e_hud", timestamp: t(4), message: { role: "user", content: "second prompt" } }),
		JSON.stringify({ type: "custom", id: "e_hud2", parentId: "e_u2", timestamp: t(5), customType: "todo_hud_state", data: {} }),
		JSON.stringify({ type: "message", id: "e_a2", parentId: "e_hud2", timestamp: t(6), message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }),
	];
	await writeFile(sessionFile, `${lines.join("\n")}\n`);

	const ready = Promise.withResolvers<SessionReadyPayload>();
	// A host that dies before ready (bad fixture, SDK load failure) rejects here
	// instead of hanging the test until its timeout.
	const failed = Promise.withResolvers<never>();
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => failed.reject(new Error(error)),
			onExit: (_id, code, reason) => failed.reject(new Error(`host exited (code ${code}): ${reason}`)),
		},
		createLogger("tree-host-test"),
		{ hostEntry: HOST_ENTRY },
	);

	try {
		await supervisor.spawn({
			id: "s_tree001",
			cwd: project,
			sessionFile,
			relayUrl: `ws://127.0.0.1:${relay.port}`,
			webUrl: "",
		});
		await Promise.race([ready.promise, failed.promise]);

		const result = await supervisor.cmd("s_tree001", { reqId: "c_tree01", cmd: "get-tree" });
		expect(result.ok).toBe(true);
		const tree = (result.ok ? result.data : undefined) as TreePayload;

		expect(tree.leafId).toBe("e_a2");
		expect(tree.truncated).toBe(false);
		expect(tree.nodes).toHaveLength(1);
		const u1 = tree.nodes[0]!;
		expect(u1).toMatchObject({ id: "e_u1", parentId: null, type: "message", role: "user", preview: "first prompt", branch: true });
		expect(u1.leaf).toBeUndefined();
		expect(u1.children).toHaveLength(1);
		const a1 = u1.children[0]!;
		expect(a1).toMatchObject({ id: "e_a1", parentId: "e_u1", preview: "first answer", branch: true });
		// The pruned HUD note vanished; its child re-homed onto the kept ancestor.
		const u2 = a1.children[0]!;
		expect(u2).toMatchObject({ id: "e_u2", parentId: "e_a1", role: "user", preview: "second prompt", branch: true });
		expect(a1.children).toHaveLength(1);
		const a2 = u2.children[0]!;
		expect(a2).toMatchObject({ id: "e_a2", parentId: "e_u2", role: "assistant", preview: "second answer", branch: true, leaf: true });
		expect(a2.children).toEqual([]);
	} finally {
		await supervisor.stopAll("tree test done");
		relay.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
