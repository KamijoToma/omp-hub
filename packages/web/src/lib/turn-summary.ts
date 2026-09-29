import type { ActiveTool } from "./client";
import type { AssistantMessage, SessionEntry } from "./wire";

export interface TurnSummary {
	tools: number;
	/** Sum of *whole model requests*, not exclusive reasoning time. */
	modelMs: number | null;
	failure: "error" | "aborted" | null;
}

/** One visible agent turn; completed entries and its in-flight ghost must not double-count tools. */
export function summarizeTurn(
	entries: readonly SessionEntry[],
	ghost: AssistantMessage | null,
	ghostPending: boolean,
	tailTools: readonly ActiveTool[],
): TurnSummary {
	const ids = new Set<string>();
	let modelMs = 0;
	let missingDuration = false;
	let completed = false;
	let failure: TurnSummary["failure"] = null;

	const include = (message: AssistantMessage, pending: boolean): void => {
		for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
		if (pending) return;
		completed = true;
		if (typeof message.duration === "number" && Number.isFinite(message.duration) && message.duration >= 0) {
			modelMs += message.duration;
		} else {
			missingDuration = true;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") failure = message.stopReason;
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") include(entry.message, false);
	}
	if (ghost !== null) include(ghost, ghostPending);
	for (const tool of tailTools) ids.add(tool.toolCallId);

	return { tools: ids.size, modelMs: !completed || missingDuration ? null : modelMs, failure };
}
