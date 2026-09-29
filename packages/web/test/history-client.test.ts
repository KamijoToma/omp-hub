import { expect, test } from "bun:test";
import { GuestClient } from "../src/lib/client";
import { formatCollabLink } from "../src/lib/link";
import type { HostFrame, SessionEntry } from "../src/lib/wire";

const link = formatCollabLink("ws://127.0.0.1:12345", "historyRoom123", new Uint8Array(32));
const entry = (id: string): SessionEntry => ({
	type: "message", id, parentId: null, timestamp: "2026-06-27T00:00:00.000Z",
	message: { role: "user", content: id, timestamp: 1782518400000 },
});
const welcome = (hasMoreHistory?: boolean): HostFrame => ({
	t: "welcome", proto: 3, header: { type: "session", id: "s", cwd: "/tmp", timestamp: "2026-06-27T00:00:00.000Z" },
	state: { isStreaming: false, queuedMessageCount: 0, cwd: "/tmp", participants: [] },
	agents: [], entryCount: 1, hasMoreHistory,
});

test("older pages prepend to live entries; a new welcome invalidates outstanding page replies", () => {
	const client = new GuestClient(link, "guest");
	try {
		client.applyFrameForTest(welcome(true));
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [entry("latest")], final: true });
		client.loadOlder();
		expect(client.getSnapshot().historyLoading).toBe(true);
		client.applyFrameForTest({ t: "entry", entry: entry("live") });
		client.applyFrameForTest({ t: "history", reqId: 1, entries: [entry("earlier")], hasMore: false });
		expect(client.getSnapshot().entries.map(row => row.id)).toEqual(["earlier", "latest", "live"]);
		expect(client.getSnapshot().hasMoreHistory).toBe(false);

		client.applyFrameForTest(welcome(true));
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [entry("newest")], final: true });
		client.loadOlder();
		client.applyFrameForTest(welcome(true));
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [entry("after-rejoin")], final: true });
		client.applyFrameForTest({ t: "history", reqId: 2, entries: [entry("stale")], hasMore: false });
		expect(client.getSnapshot().entries.map(row => row.id)).toEqual(["after-rejoin"]);
		expect(client.getSnapshot().hasMoreHistory).toBe(true);
		expect(client.getSnapshot().historyLoading).toBe(false);
	} finally {
		client.close();
	}
});

test("legacy host without paging metadata stays fully readable", () => {
	const client = new GuestClient(link, "guest");
	try {
		client.applyFrameForTest(welcome());
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [entry("legacy")], final: true });
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().hasMoreHistory).toBe(false);
		client.loadOlder();
		expect(client.getSnapshot().historyLoading).toBe(false);
	} finally {
		client.close();
	}
});
