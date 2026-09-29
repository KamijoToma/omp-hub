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
	const requests: string[] = [];
	const root = await mkdtemp(path.join(tmpdir(), "omp-history-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir);
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
			requests.push(await request.text());
			const chunk = {
				id: "history-test-reply",
				object: "chat.completion.chunk",
				created: 0,
				model: "history-local",
				choices: [{ index: 0, delta: { role: "assistant", content: "offline history reply" }, finish_reason: "stop" }],
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"history-test": {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
				apiKey: "offline-test-key",
				models: [{ id: "history-local", name: "History local", reasoning: false, input: ["text"],
					contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			},
		},
	}));
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
		await supervisor.spawn({ id: "s_history01", cwd, agentDir, sessionFile, relayUrl: hub.url, webUrl: "" });
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
		const selected = await supervisor.cmd("s_history01", {
			reqId: "c_history_model", cmd: "set-model", provider: "history-test", modelId: "history-local",
		});
		expect(selected).toMatchObject({ ok: true, data: { switched: true } });
		guest.sendPrompt("browser interaction before loading history");
		await until("live guest prompt", () => guest!.getSnapshot().entries.some(entry =>
			entry.type === "custom_message" && entry.customType === "collab-prompt" &&
			JSON.stringify(entry).includes("browser interaction before loading history")));
		await until("offline assistant reply", () => guest!.getSnapshot().entries.some(entry =>
			entry.type === "message" && entry.message.role === "assistant" &&
			JSON.stringify(entry).includes("offline history reply")));
		expect(requests.some(body => body.includes("browser interaction before loading history"))).toBe(true);
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
		provider.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
