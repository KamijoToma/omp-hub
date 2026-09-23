/**
 * Collapsible todo strip docked above the composer. The board is derived
 * purely from transcript entries (see todo-board.ts), so it works on write
 * and view links alike and follows rewind/rejoin snapshot trimming with no
 * extra host traffic.
 */
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { SessionEntry } from "../lib/wire";
import { truncate } from "../tool-render/util";
import { latestTodoBoard, type TodoTaskStatus } from "./todo-board";

/** Collapse preference; absent = expanded so the list is visible by default. */
const COLLAPSE_KEY = "omp-hub.todo-collapsed";

const TASK_ICONS: Record<TodoTaskStatus, string> = {
	completed: "✓",
	in_progress: "→",
	abandoned: "✕",
	pending: "○",
};

/** One-based roman numeral for phase headers (mirrors tool-render/tools/todo.tsx). */
function roman(n: number): string {
	const pairs: ReadonlyArray<readonly [number, string]> = [
		[1000, "M"],
		[900, "CM"],
		[500, "D"],
		[400, "CD"],
		[100, "C"],
		[90, "XC"],
		[50, "L"],
		[40, "XL"],
		[10, "X"],
		[9, "IX"],
		[5, "V"],
		[4, "IV"],
		[1, "I"],
	];
	let out = "";
	let rem = n;
	for (const [value, sym] of pairs) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/** Collapse preference; absent = expanded so the list is visible by default. Shared with controllers. */
export const TODO_COLLAPSE_KEY = "omp-hub.todo-collapsed";

export function TodoPanel({
	entries,
	open: openProp,
	onToggle,
}: {
	entries: readonly SessionEntry[];
	/** Controlled open state; omitted = the panel owns it. */
	open?: boolean;
	onToggle?(): void;
}): ReactNode {
	const board = useMemo(() => latestTodoBoard(entries), [entries]);
	const [openState, setOpenState] = useState(() => localStorage.getItem(TODO_COLLAPSE_KEY) !== "1");
	const open = openProp ?? openState;
	const toggle = (): void => {
		if (onToggle) {
			localStorage.setItem(TODO_COLLAPSE_KEY, open ? "0" : "1");
			onToggle();
			return;
		}
		setOpenState(prev => {
			localStorage.setItem(TODO_COLLAPSE_KEY, prev ? "0" : "1");
			return !prev;
		});
	};
	if (board === null) return null;
	return (
		<section className="hb-todo" aria-label="Agent todo list">
			<button type="button" className="hb-todo-head" onClick={toggle} aria-expanded={open}>
				<ListChecks size={13} aria-hidden />
				<span className="hb-todo-label">TODO</span>
				<span className="hb-todo-progress">
					{board.done}/{board.total}
				</span>
				{board.current && (
					<span className="hb-todo-current">
						<span className="tv-task-icon" aria-hidden>
							→
						</span>
						{truncate(board.current.content, 80)}
					</span>
				)}
				<span className="hb-todo-chevron" aria-hidden>
					{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
				</span>
			</button>
			{open && (
				<div className="hb-todo-body">
					<div className="tv-todo">
						{board.phases.flatMap((phase, i) => [
							<div key={`p${i}`} className="tv-todo-phase">
								{roman(i + 1)}. {phase.name}
							</div>,
							...phase.tasks.map((task, t) => (
								<div key={`p${i}t${t}`} className={`tv-task tv-task--${task.status}`}>
									<span className="tv-task-icon" aria-hidden>
										{TASK_ICONS[task.status]}
									</span>
									<span>{task.content}</span>
								</div>
							)),
						])}
					</div>
				</div>
			)}
		</section>
	);
}
