/**
 * Steering-message queue (TUI input-controller parity): delivered-entry
 * matching with cursor anchoring, duplicate-text settling, and the settle
 * rules that clear the queue when the connection leaves the live phase or
 * the host drains it.
 */
import { describe, expect, test } from "bun:test";
import type { GuestSnapshot } from "../src/lib/client";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CustomMessageEntry, type MessageEntry, type SessionEntry, type SessionState } from "../src/lib/wire";
import {
	collabPromptEntryText,
	reconcilePendingSteers,
	settlePendingSteers,
	type PendingSteer,
} from "../src/hub/steering-queue";

let entrySeq = 0;

function collabEntry(text: string, content?: CustomMessageEntry["content"]): CustomMessageEntry {
	entrySeq += 1;
	return {
		type: "custom_message",
		customType: COLLAB_PROMPT_MESSAGE_TYPE,
		id: `e${entrySeq}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		content: content ?? text,
		display: true,
	};
}

function plainEntry(): SessionEntry {
	entrySeq += 1;
	return {
		type: "message",
		id: `m${entrySeq}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "unrelated", timestamp: Date.now() },
	} as MessageEntry;
}

function steer(text: string, cursor: number): PendingSteer {
	return { text, cursor };
}

function snap(overrides: {
	phase?: GuestSnapshot["phase"];
	working?: boolean;
	state?: Partial<SessionState> | null;
	entries?: readonly SessionEntry[];
}): Pick<GuestSnapshot, "phase" | "working" | "state" | "entries"> {
	return {
		phase: overrides.phase ?? "live",
		working: overrides.working ?? true,
		state:
			overrides.state === null
				? null
				: ({
						isStreaming: true,
						queuedMessageCount: 0,
						cwd: "/tmp",
						participants: [],
						...overrides.state,
					} as SessionState),
		entries: overrides.entries ?? [],
	};
}

describe("collabPromptEntryText", () => {
	test("reads string content verbatim", () => {
		expect(collabPromptEntryText(collabEntry("check the logs"))).toBe("check the logs");
	});

	test("reads the first text block when content is structured", () => {
		const entry = collabEntry("", [
			{ type: "text", text: "with image" },
			{ type: "image", mimeType: "image/png", data: "x" },
		]);
		expect(collabPromptEntryText(entry)).toBe("with image");
	});

	test("ignores other custom messages and non-custom entries", () => {
		const other = { ...collabEntry("nope"), customType: "something-else" };
		expect(collabPromptEntryText(other)).toBeUndefined();
		expect(collabPromptEntryText(plainEntry())).toBeUndefined();
	});
});

describe("reconcilePendingSteers", () => {
	test("drops a steer once a matching entry lands at or after its cursor", () => {
		const entries = [plainEntry(), collabEntry("check the logs")];
		const settled = reconcilePendingSteers([steer("check the logs", 1)], entries);
		expect(settled).toHaveLength(0);
	});

	test("ignores an identical entry older than the cursor", () => {
		const entries = [collabEntry("run it"), plainEntry()];
		const settled = reconcilePendingSteers([steer("run it", 1)], entries);
		expect(settled).toEqual([steer("run it", 1)]);
	});

	test("settles duplicate texts in submission order, one entry each", () => {
		const entries = [collabEntry("ok"), collabEntry("ok")];
		const settled = reconcilePendingSteers([steer("ok", 0), steer("ok", 1)], entries);
		expect(settled).toHaveLength(0);
	});

	test("keeps steers whose entry has not landed", () => {
		const entries = [collabEntry("first")];
		const pending = [steer("first", 0), steer("second", 1)];
		const settled = reconcilePendingSteers(pending, entries);
		expect(settled).toEqual([steer("second", 1)]);
	});

	test("matches structured content against the plain submitted text", () => {
		const entries = [collabEntry("", [{ type: "text", text: "with image" }])];
		expect(reconcilePendingSteers([steer("with image", 0)], entries)).toHaveLength(0);
	});

	test("returns the input untouched when nothing is pending", () => {
		const pending: readonly PendingSteer[] = [];
		expect(reconcilePendingSteers(pending, [collabEntry("x")])).toBe(pending);
	});
});

describe("settlePendingSteers", () => {
	test("clears everything when the connection leaves the live phase", () => {
		const pending = [steer("check", 0)];
		expect(settlePendingSteers(pending, snap({ phase: "reconnecting", entries: [] }))).toHaveLength(0);
		expect(settlePendingSteers(pending, snap({ phase: "waiting", entries: [] }))).toHaveLength(0);
	});

	test("clears everything once the host is idle with an empty queue", () => {
		const pending = [steer("never matched", 0)];
		const state = { isStreaming: false, working: undefined } as Partial<SessionState>;
		expect(settlePendingSteers(pending, snap({ working: false, state, entries: [plainEntry()] }))).toHaveLength(0);
	});

	test("keeps unmatched steers while the host still holds queued messages", () => {
		const pending = [steer("still queued", 0)];
		const settled = settlePendingSteers(
			pending,
			snap({ working: false, state: { isStreaming: false, queuedMessageCount: 1 }, entries: [plainEntry()] }),
		);
		expect(settled).toEqual(pending);
	});

	test("reconciles against delivered entries while streaming", () => {
		const pending = [steer("delivered", 0), steer("pending", 1)];
		const settled = settlePendingSteers(pending, snap({
			working: true,
			state: { queuedMessageCount: 1 },
			entries: [collabEntry("delivered")],
		}));
		expect(settled).toEqual([steer("pending", 1)]);
	});
});
