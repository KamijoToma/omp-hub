import { expect, test } from "bun:test";
import { rewindTargets } from "../src/hub/RewindPicker";
import { COLLAB_PROMPT_MESSAGE_TYPE, type SessionEntry } from "../src/lib/wire";

test("rewind offers a collab prompt on the active branch, but not unrelated custom messages", () => {
	const timestamp = "2026-09-23T08:00:00.000Z";
	const entries: SessionEntry[] = [
		{
			type: "custom_message",
			id: "guest-prompt",
			parentId: null,
			timestamp,
			customType: COLLAB_PROMPT_MESSAGE_TYPE,
			content: "Reply with one word: Ready.",
			display: true,
		},
		{
			type: "custom_message",
			id: "system-note",
			parentId: "guest-prompt",
			timestamp,
			customType: "runtime-note",
			content: "Internal event",
			display: false,
		},
		{
			type: "message",
			id: "answer",
			parentId: "system-note",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Ready." }],
				model: "deepseek-flash",
				usage: { input: 258, output: 3, cacheRead: 20_200, cacheWrite: 0, totalTokens: 20_461, cost: { total: 0.000202 } },
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			},
		},
	];

	expect(rewindTargets(entries).map(({ entry, preview }) => ({ id: entry.id, preview }))).toEqual([
		{ id: "guest-prompt", preview: "Reply with one word: Ready." },
	]);
});
