import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "../../hub/src/server";
import { GuestClient } from "../../web/src/lib/client";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const HOST_ENTRY = new URL("../src/session-host.ts", import.meta.url).pathname;

async function until(what: string, predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

test("browser guest sees the newest page first and can page back over the real encrypted relay", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-history-"));
	const cwd = path.join(root, "project");
	await mkdir(cwd);
	const sessionFile = path.join(root, "history.jsonl");
	const lines = [JSON.stringify({
		type: "session", version: 3, id: "historysession01", timestamp: "2026-06-27T00:00:00.000Z", cwd,
	})];
	for (let index = 0; index < 190; index++) {
		lines.push(JSON.stringify({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "2026-06-27T00:00:00.000Z",
			message: { role: "user", content: `question ${index}`, timestamp: 1782518400000 + index },
		}));
	}
	await writeFile(sessionFile, `${lines.join("\n")}\n`);

	const hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const errors: string[] = [];
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: (_id, error) => errors.push(error),
			onExit: (_id, _code, reason) => errors.push(reason),
		},
		createLogger("history-test"),
		{ hostEntry: HOST_ENTRY },
	);
	let guest: GuestClient | undefined;
	let viewer: GuestClient | undefined;
	try {
		await supervisor.spawn({ id: "s_history01", cwd, sessionFile, relayUrl: hub.url, webUrl: "" });
		const payload = await ready.promise;
		guest = new GuestClient(payload.links.full, "history-test");
		guest.connect();
		await until("recent snapshot", () => guest!.getSnapshot().phase === "live");
		let snap = guest.getSnapshot();
		expect(snap.entries).toHaveLength(80);
		expect(snap.entries[0]?.id).toBe("entry-110");
		expect(snap.entries.at(-1)?.id).toBe("entry-189");
		expect(snap.entries.some(entry => entry.id === "entry-0")).toBe(false);
		expect(snap.hasMoreHistory).toBe(true);
		expect(snap.readOnly).toBe(false);
		guest.sendPrompt("browser interaction before loading history");
		await until("live guest prompt", () => JSON.stringify(guest!.getSnapshot().entries.at(-1)).includes("browser interaction before loading history"));
		snap = guest.getSnapshot();
		expect(snap.hasMoreHistory).toBe(true);

		while (snap.hasMoreHistory) {
			const count = snap.entries.length;
			guest.loadOlder();
			expect(guest.getSnapshot().historyLoading).toBe(true);
			await until("older page", () => !guest!.getSnapshot().historyLoading);
			snap = guest.getSnapshot();
			expect(snap.historyError).toBeNull();
			expect(snap.entries.length).toBeGreaterThan(count);
		}
		expect(snap.entries.filter(entry => entry.id?.startsWith("entry-"))).toHaveLength(190);
		expect(JSON.stringify(snap.entries[0])).toContain("question 0");
		expect(JSON.stringify(snap.entries)).toContain("question 189");
		expect(JSON.stringify(snap.entries)).toContain("browser interaction before loading history");
		expect(guest.getSnapshot().phase).toBe("live");
		viewer = new GuestClient(payload.links.view, "viewer");
		viewer.connect();
		await until("view-only recent snapshot", () => viewer!.getSnapshot().phase === "live");
		expect(viewer.getSnapshot().readOnly).toBe(true);
		expect(viewer.getSnapshot().entries).toHaveLength(80);
		expect(viewer.getSnapshot().hasMoreHistory).toBe(true);
		viewer.loadOlder();
		await until("view-only older page", () => !viewer!.getSnapshot().historyLoading);
		expect(viewer.getSnapshot().entries.length).toBeGreaterThan(80);
		expect(errors).toEqual([]);
	} finally {
		viewer?.close();
		guest?.close();
		await supervisor.stopAll("history test done");
		hub.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
