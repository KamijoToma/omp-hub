/**
 * Headless session context: the collab host's context adapter and the
 * `get-context` IPC payload.
 *
 * The collab host is the shape proven by oh-my-pi's test/collab/read-only.test.ts
 * (`makeHostContext`), but backed by the real session/settings/event bus instead
 * of doubles: CollabHost only touches these members, so the cast to the full
 * `InteractiveModeContext` never reaches TUI state.
 *
 * Both helpers import the SDK for types only, so each stays exercisable from a
 * session double without booting a session child.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/** The session slice the context adapter reads; a real AgentSession satisfies it. */
interface ContextUsageSource {
	getContextUsage(): { tokens: number; contextWindow: number } | undefined;
	readonly model: { readonly contextWindow: number | null } | undefined;
}

/** Category ids `get-context` reports — the SDK's own /context split. */
export type SessionContextCategoryId = "systemPrompt" | "systemTools" | "systemContext" | "skills" | "messages";

/** One `get-context` category: an estimate and its label, never prompt or tool text. */
export interface SessionContextCategory {
	id: SessionContextCategoryId;
	label: string;
	tokens: number;
}

/** `get-context` payload (protocol §4). */
export interface SessionContextPayload {
	contextWindow: number;
	usedTokens: number;
	categories: SessionContextCategory[];
	autoCompactBufferTokens: number;
	freeTokens: number;
}

/**
 * The breakdown slice {@link sessionContextPayload} reads. The SDK's
 * `ContextBreakdown` satisfies it structurally; the fields it does not name here
 * (the model object, renderer colors/glyphs, the snapcompact estimate) are
 * exactly what that function drops from the wire.
 */
export interface SessionContextBreakdownSource {
	readonly contextWindow: number;
	readonly usedTokens: number;
	readonly categories: readonly SessionContextCategory[];
	readonly autoCompactBufferTokens: number;
	readonly freeTokens: number;
}

/**
 * Live context numbers for the collab state frames, in the shape the status line
 * publishes (`getCachedContextBreakdown`). A TUI status line memoizes its own
 * anchored breakdown; a headless session has none, so the numbers come straight
 * from the session's provider-anchored usage. `getContextUsage` carries a zero
 * window while no model is selected (and nothing at all when it cannot account
 * for the session), so the model's declared window backs the fallback and a
 * missing model stays 0 instead of throwing mid-broadcast.
 */
export function collabContextUsage(session: ContextUsageSource): { usedTokens: number; contextWindow: number } {
	const usage = session.getContextUsage();
	return {
		usedTokens: usage?.tokens ?? 0,
		contextWindow: usage?.contextWindow || session.model?.contextWindow || 0,
	};
}

/**
 * IPC view of the SDK's estimated context breakdown (`get-context`). Categories
 * keep id/label/tokens only — the renderer's colors/glyphs, the full model
 * object, and the snapcompact estimate are child-side presentation. Messages ride
 * as one estimated category: the SDK does not honestly split them by role.
 */
export function sessionContextPayload(breakdown: SessionContextBreakdownSource): SessionContextPayload {
	return {
		contextWindow: breakdown.contextWindow,
		usedTokens: breakdown.usedTokens,
		categories: breakdown.categories.map(category => ({
			id: category.id,
			label: category.label,
			tokens: category.tokens,
		})),
		autoCompactBufferTokens: breakdown.autoCompactBufferTokens,
		freeTokens: breakdown.freeTokens,
	};
}

export function buildCollabCtx(session: AgentSession, eventBus: EventBus): InteractiveModeContext {
	return {
		settings: session.settings,
		sessionManager: session.sessionManager,
		session,
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => collabContextUsage(session),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}
