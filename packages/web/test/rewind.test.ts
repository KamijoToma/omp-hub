import { expect, test } from "bun:test";
import { rewindTargetMap, rewindTargets } from "../src/hub/RewindPicker";
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

test("rewind follows replica order, not parentId chains full of pruned holes", () => {
	const timestamp = "2026-09-23T08:00:00.000Z";
	const prompt = (id: string, text: string, parentId: string | null): SessionEntry => ({
		type: "custom_message",
		id,
		parentId,
		timestamp,
		customType: COLLAB_PROMPT_MESSAGE_TYPE,
		content: text,
		display: true,
	});
	const assistant = (id: string, parentId: string, text: string): SessionEntry => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "deepseek-flash",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		},
	});
	// Real hosts interleave non-wire entries (`custom` HUD notes, model_usage)
	// that the snapshot filter never sends, so parent ids dangle in the guest
	// replica. The targets walk must not depend on those links existing.
	const entries: SessionEntry[] = [
		prompt("p1", "first prompt", null),
		assistant("a1", "p1", "first answer"),
		assistant("a2", "pruned-custom", "second answer"),
		prompt("p2", "second prompt", "pruned-custom"),
		assistant("a3", "also-pruned", "final answer"),
	];

	const targets = rewindTargets(entries);
	expect(targets.map(target => target.entry.id)).toEqual(["p2", "p1"]);
	expect(targets.map(target => target.droppedCount)).toEqual([2, 5]);

	const map = rewindTargetMap(entries);
	expect(map.get("p1")).toBe("p1");
	expect(map.get("a1")).toBe("p1");
	expect(map.get("a3")).toBe("p2");
	expect(map.get("prelude")).toBeUndefined();
});
