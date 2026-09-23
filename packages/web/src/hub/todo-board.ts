/**
 * Derive the agent's current todo board from the live transcript entries.
 *
 * Every state-changing `todo` tool result carries the full committed board in
 * `details.phases` (the agent-side `committedTodoPhases` rule), so the latest
 * valid result *is* the current state — no host or wire changes needed.
 * `view` results and failed calls are skipped, mirroring the agent side.
 */
import type { SessionEntry } from "../lib/wire";

export type TodoTaskStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTaskView {
	content: string;
	status: TodoTaskStatus;
}

export interface TodoPhaseView {
	name: string;
	tasks: TodoTaskView[];
}

/** Latest committed board plus the precomputed facts the strip row shows. */
export interface TodoBoard {
	phases: TodoPhaseView[];
	/** Completed task count. */
	done: number;
	/** Total task count. */
	total: number;
	/** What the agent should be on: first in-progress task, else first pending. */
	current: { phase: string; content: string } | null;
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "abandoned"]);

function parseTask(value: unknown): TodoTaskView | null {
	if (typeof value !== "object" || value === null) return null;
	const rec = value as Record<string, unknown>;
	if (typeof rec.content !== "string") return null;
	const status = typeof rec.status === "string" && STATUSES.has(rec.status) ? (rec.status as TodoTaskStatus) : "pending";
	return { content: rec.content, status };
}

/** Strict shape check: one bad phase/task invalidates the whole snapshot. */
function parsePhases(value: unknown): TodoPhaseView[] | null {
	if (!Array.isArray(value)) return null;
	const phases: TodoPhaseView[] = [];
	for (const phase of value) {
		if (typeof phase !== "object" || phase === null) return null;
		const rec = phase as Record<string, unknown>;
		if (typeof rec.name !== "string" || !Array.isArray(rec.tasks)) return null;
		const tasks: TodoTaskView[] = [];
		for (const task of rec.tasks) {
			const parsed = parseTask(task);
			if (parsed === null) return null;
			tasks.push(parsed);
		}
		phases.push({ name: rec.name, tasks });
	}
	return phases;
}

/** Committed phases from one entry, or null when the entry is not a todo commit. */
function committedPhases(entry: SessionEntry): TodoPhaseView[] | null {
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (message.role !== "toolResult") return null;
	if (message.toolName !== "todo" || message.isError) return null;
	if (typeof message.details !== "object" || message.details === null) return null;
	const details = message.details as Record<string, unknown>;
	// `view` mirrors state without committing it; keep the last real commit.
	if (details.op === "view") return null;
	return parsePhases(details.phases);
}

/**
 * Latest committed todo board across the entry list, or null when there is
 * nothing to show: no todo use yet, an all-removed board, or only malformed
 * snapshots (which never clobber the last good one).
 */
export function latestTodoBoard(entries: readonly SessionEntry[]): TodoBoard | null {
	let phases: TodoPhaseView[] | null = null;
	for (const entry of entries) {
		const next = committedPhases(entry);
		if (next !== null) phases = next;
	}
	if (phases === null) return null;
	let total = 0;
	let done = 0;
	let current: TodoBoard["current"] = null;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			total++;
			if (task.status === "completed") done++;
			if (current === null && task.status === "in_progress") {
				current = { phase: phase.name, content: task.content };
			}
		}
	}
	if (total === 0) return null;
	if (current === null) {
		for (const phase of phases) {
			const pending = phase.tasks.find(task => task.status === "pending");
			if (pending) {
				current = { phase: phase.name, content: pending.content };
				break;
			}
		}
	}
	return { phases, total, done, current };
}
