/**
 * Collab host context for a headless session.
 *
 * Exactly the shape proven by oh-my-pi's test/collab/read-only.test.ts
 * (`makeHostContext`), but backed by the real session/settings/event bus instead
 * of doubles: CollabHost only touches these members, so the cast to the full
 * `InteractiveModeContext` never reaches TUI state.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

export function buildCollabCtx(session: AgentSession, eventBus: EventBus): InteractiveModeContext {
	return {
		settings: session.settings,
		sessionManager: session.sessionManager,
		session,
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}
