/**
 * Headless context reporting (collab-ctx.ts): the numbers CollabHost reads off
 * the status line, and the `get-context` payload the hub pulls over the child's
 * JSONL channel.
 *
 * Both are pure functions of the session, so they run against doubles here —
 * collab-ctx imports the SDK for types only, while a real child needs a relay,
 * credentials, and the full SDK to boot.
 */

import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	buildCollabCtx,
	type SessionContextBreakdownSource,
	type SessionContextCategoryId,
	sessionContextPayload,
} from "../src/collab-ctx";

/**
 * `statusLine.getCachedContextBreakdown` over a session double — the exact member
 * CollabHost calls when it builds a state frame.
 */
function collabBreakdown(session: {
	getContextUsage: () => { tokens: number; contextWindow: number } | undefined;
	model?: { contextWindow: number | null } | null;
}): () => { usedTokens: number; contextWindow: number } {
	const ctx = buildCollabCtx(
		{ settings: {}, sessionManager: {}, ...session } as unknown as AgentSession,
		{} as EventBus,
	);
	return () => ctx.statusLine.getCachedContextBreakdown();
}

/** The SDK's ContextBreakdown, presentation fields included, as `get-context` receives it. */
interface SdkBreakdown extends SessionContextBreakdownSource {
	model: { provider: string; id: string; contextWindow: number };
	categories: {
		id: SessionContextCategoryId;
		label: string;
		tokens: number;
		color: string;
		glyph: string;
	}[];
	snapcompact?: { visionCapable: boolean; savedTokens: number };
}

function sdkBreakdown(): SdkBreakdown {
	return {
		model: { provider: "vendor", id: "vendor/some-model", contextWindow: 200_000 },
		contextWindow: 200_000,
		usedTokens: 54_900,
		categories: [
			{ id: "systemPrompt", label: "System prompt", tokens: 3_120, color: "accent", glyph: "⛁" },
			{ id: "systemTools", label: "System tools", tokens: 8_400, color: "warning", glyph: "⛁" },
			{ id: "systemContext", label: "System context", tokens: 910, color: "customMessageLabel", glyph: "⛁" },
			{ id: "skills", label: "Skills", tokens: 1_270, color: "success", glyph: "⛁" },
			{ id: "messages", label: "Messages", tokens: 41_200, color: "userMessageText", glyph: "⛃" },
		],
		autoCompactBufferTokens: 20_000,
		freeTokens: 125_100,
		snapcompact: { visionCapable: true, savedTokens: 12_345 },
	};
}

test("collab context numbers follow the session's live usage instead of fixed zeros", () => {
	let usage = { tokens: 12_480, contextWindow: 200_000 };
	const breakdown = collabBreakdown({ model: { contextWindow: 200_000 }, getContextUsage: () => usage });
	expect(breakdown()).toEqual({ usedTokens: 12_480, contextWindow: 200_000 });

	// The provider-anchored count moves as the turn runs: the next state frame
	// must carry the new numbers, not the ones captured at construction.
	usage = { tokens: 96_512, contextWindow: 200_000 };
	expect(breakdown()).toEqual({ usedTokens: 96_512, contextWindow: 200_000 });
});

test("collab context numbers stay measurable without a model or usage", () => {
	// No model selected: usage still counts tokens, and the window stays 0 rather
	// than throwing mid-broadcast (CollabHost reports 0 percent then).
	expect(collabBreakdown({ getContextUsage: () => ({ tokens: 4_096, contextWindow: 0 }) })()).toEqual({
		usedTokens: 4_096,
		contextWindow: 0,
	});
	// Session cannot account for itself, and no model carries a window either.
	expect(collabBreakdown({ getContextUsage: () => undefined })()).toEqual({ usedTokens: 0, contextWindow: 0 });
});

test("collab context numbers fall back to the model's declared window", () => {
	// Usage computed before a model was selected reports a zero window; the model
	// the session now runs supplies it, so guests still get a usable gauge.
	expect(
		collabBreakdown({
			model: { contextWindow: 32_768 },
			getContextUsage: () => ({ tokens: 4_096, contextWindow: 0 }),
		})(),
	).toEqual({ usedTokens: 4_096, contextWindow: 32_768 });
	expect(
		collabBreakdown({
			model: { contextWindow: null },
			getContextUsage: () => ({ tokens: 1_024, contextWindow: 0 }),
		})(),
	).toEqual({ usedTokens: 1_024, contextWindow: 0 });
});

test("get-context payload serializes to numbers and labels without the model or prompt", () => {
	const payload = sessionContextPayload(sdkBreakdown());

	// JSON is the child's wire format: the round trip pins the full payload, so a
	// leaked model object, renderer glyph/color, or snapcompact estimate fails here.
	expect(JSON.parse(JSON.stringify(payload))).toEqual({
		contextWindow: 200_000,
		usedTokens: 54_900,
		categories: [
			{ id: "systemPrompt", label: "System prompt", tokens: 3_120 },
			{ id: "systemTools", label: "System tools", tokens: 8_400 },
			{ id: "systemContext", label: "System context", tokens: 910 },
			{ id: "skills", label: "Skills", tokens: 1_270 },
			{ id: "messages", label: "Messages", tokens: 41_200 },
		],
		autoCompactBufferTokens: 20_000,
		freeTokens: 125_100,
	});
});
