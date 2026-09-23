/**
 * `activeModelRole` decides when the header shows the `@role` badge. Two ways
 * to regress: the last switch must win (not the first), and a recorded role
 * whose model is no longer active must hide the badge instead of lying.
 */
import { describe, expect, test } from "bun:test";
import { activeModelRole } from "../src/lib/model-role";
import type { ModelChangeEntry, SessionEntry, WireModel } from "../src/lib/wire";

let seq = 0;
/**
 * Builds a `model_change` entry; the seven call sites share this shape so ids
 * stay unique and new required entry fields fail every fixture at once.
 */
function modelChange(model: string, role?: string): ModelChangeEntry {
	seq += 1;
	return { type: "model_change", id: `m${seq}`, parentId: null, timestamp: "2026-01-01T00:00:00Z", model, role };
}

const T1: SessionEntry = {
	type: "thinking_level_change",
	id: "t1",
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	thinkingLevel: "high",
};

const GPT: WireModel = { id: "gpt-5", name: "GPT-5", provider: "openai", contextWindow: 400_000 };

describe("activeModelRole", () => {
	test("is null before any in-session model switch", () => {
		expect(activeModelRole([T1], GPT)).toBeNull();
		expect(activeModelRole([], GPT)).toBeNull();
	});

	test("is null without an active model", () => {
		expect(activeModelRole([modelChange("openai/gpt-5", "smol")], null)).toBeNull();
		expect(activeModelRole([modelChange("openai/gpt-5", "smol")], undefined)).toBeNull();
	});

	test("the last model_change names the current role", () => {
		const list: SessionEntry[] = [
			modelChange("openai/gpt-5", "smol"),
			{
				type: "thinking_level_change",
				id: "t2",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				thinkingLevel: "low",
			},
			modelChange("openai/gpt-5", "slow"),
		];
		expect(activeModelRole(list, GPT)).toBe("slow");
	});

	test("a model_change without a role reads as default", () => {
		expect(activeModelRole([modelChange("openai/gpt-5")], GPT)).toBe("default");
	});

	test("a recorded role is dropped once the active model moved on", () => {
		const list: SessionEntry[] = [modelChange("openai/gpt-5", "smol"), modelChange("anthropic/claude", "slow")];
		expect(activeModelRole(list, GPT)).toBeNull();
	});

	test("matches provider and id, not the model display name", () => {
		const renamed: WireModel = { ...GPT, name: "Something Else" };
		expect(activeModelRole([modelChange("openai/gpt-5", "smol")], renamed)).toBe("smol");
		expect(activeModelRole([modelChange("openai/gpt-5.1", "smol")], GPT)).toBeNull();
	});
});
