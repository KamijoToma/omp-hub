import { expect, test } from "bun:test";
import { latestTodoBoard } from "../src/hub/todo-board";
import type { SessionEntry } from "../src/lib/wire";

let seq = 0;

/** Distributive Omit so each union variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EntryBody = DistributiveOmit<SessionEntry, "id" | "parentId" | "timestamp">;

function entry(partial: EntryBody): SessionEntry {
	seq += 1;
	return { id: `e${seq}`, parentId: seq > 1 ? `e${seq - 1}` : null, timestamp: "2026-09-23T08:00:00.000Z", ...partial } as SessionEntry;
}

function todoResult(details: unknown, opts?: { isError?: boolean }): SessionEntry {
	return entry({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: `call-${seq}`,
			toolName: "todo",
			content: [],
			details,
			isError: opts?.isError ?? false,
			timestamp: 0,
		},
	});
}

function phases(partial: {
	name: string;
	tasks: Array<{ content: string; status: string }>;
}): unknown {
	return { op: "update", phases: [partial] };
}

test("no todo results → null board", () => {
	const entries: SessionEntry[] = [
		entry({ type: "custom_message", customType: "collab-prompt", content: "hi", display: true }),
	];
	expect(latestTodoBoard(entries)).toBeNull();
});

test("init commits the board; counts and pending fallback current", () => {
	const entries: SessionEntry[] = [
		todoResult({
			op: "init",
			phases: [
				{
					name: "Setup",
					tasks: [
						{ content: "Scaffold crate", status: "completed" },
						{ content: "Wire workspace", status: "pending" },
					],
				},
				{ name: "Auth", tasks: [{ content: "Port credential store", status: "pending" }] },
			],
		}),
	];
	const board = latestTodoBoard(entries);
	expect(board?.total).toBe(3);
	expect(board?.done).toBe(1);
	expect(board?.current).toEqual({ phase: "Setup", content: "Wire workspace" });
	expect(board?.phases.map(p => p.name)).toEqual(["Setup", "Auth"]);
});

test("later commits win; in_progress is preferred for current", () => {
	const entries: SessionEntry[] = [
		todoResult({
			op: "init",
			phases: [{ name: "Tasks", tasks: [{ content: "A", status: "in_progress" }] }],
		}),
		entry({ type: "message", message: { role: "assistant", content: [], model: "m", usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 },
		}, stopReason: "toolUse", timestamp: 0 } }),
		todoResult({
			op: "done",
			phases: [
				{
					name: "Tasks",
					tasks: [
						{ content: "A", status: "completed" },
						{ content: "B", status: "in_progress" },
						{ content: "C", status: "pending" },
					],
				},
			],
		}),
	];
	const board = latestTodoBoard(entries);
	expect(board?.done).toBe(1);
	expect(board?.total).toBe(3);
	expect(board?.current).toEqual({ phase: "Tasks", content: "B" });
});

test("view results, failed calls, and malformed snapshots are ignored", () => {
	const good = { op: "init", phases: [{ name: "Tasks", tasks: [{ content: "A", status: "pending" }] }] };
	const entries: SessionEntry[] = [
		todoResult(good),
		// `view` mirrors state without committing it.
		todoResult({ op: "view", phases: [{ name: "Ghost", tasks: [{ content: "X", status: "in_progress" }] }] }),
		// Failed call: details are not a committed board.
		todoResult({ op: "init", phases: [] }, { isError: true }),
		// Malformed shape: one bad task invalidates the snapshot.
		todoResult({ op: "update", phases: [{ name: "Tasks", tasks: [{ status: "pending" }] }] }),
		// Wrong tool entirely.
		entry({
			type: "message",
			message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [], isError: false, timestamp: 0 },
		}),
	];
	const board = latestTodoBoard(entries);
	expect(board?.total).toBe(1);
	expect(board?.current).toEqual({ phase: "Tasks", content: "A" });
});

test("a malformed first snapshot is not a board", () => {
	expect(latestTodoBoard([todoResult({ op: "init" })])).toBeNull();
	expect(latestTodoBoard([todoResult({ op: "init", phases: "nope" })])).toBeNull();
	expect(latestTodoBoard([todoResult({ op: "init", phases: [42] })])).toBeNull();
});

test("an emptied board hides the panel", () => {
	const entries: SessionEntry[] = [
		todoResult({ op: "init", phases: [{ name: "Tasks", tasks: [{ content: "A", status: "pending" }] }] }),
		todoResult({ op: "rm", phases: [{ name: "Tasks", tasks: [] }] }),
	];
	expect(latestTodoBoard(entries)).toBeNull();
});

test("unknown statuses degrade to pending; abandoned is not done and not current", () => {
	const entries: SessionEntry[] = [
		todoResult({
			op: "update",
			phases: [
				{
					name: "Tasks",
					tasks: [
						{ content: "Gone", status: "abandoned" },
						{ content: "Weird", status: "blocked" },
					],
				},
			],
		}),
	];
	const board = latestTodoBoard(entries);
	expect(board?.done).toBe(0);
	expect(board?.total).toBe(2);
	expect(board?.current).toEqual({ phase: "Tasks", content: "Weird" });
	expect(board?.phases[0].tasks[0].status).toBe("abandoned");
	expect(board?.phases[0].tasks[1].status).toBe("pending");
});
