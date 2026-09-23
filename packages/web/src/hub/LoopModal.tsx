/**
 * `/loop` — drive the session's loop controller. The status card reads the
 * `loop` field of the shared `agent-state` fetch; actions POST `…/loop` and
 * refresh the state. The limit field accepts an iteration count (`10`) or a
 * duration (`10m`, `1h30m`) — parsed client-side, so a bad value is a local
 * notice and never a request. 400s from the hub surface the same way.
 */
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Notice } from "../lib/client";
import { fmtDuration } from "../lib/format";
import type { LoopAction, LoopLimit, LoopStatus } from "./api";
import { errorText, postLoop } from "./api";
import { parseLoopLimit } from "./commands";
import { Modal } from "./Modal";
import type { AgentStateLoad } from "./use-agent-state";
import { useAgentState } from "./use-agent-state";

export interface LoopModalProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

export function LoopModal({ sessionId, notify, onClose }: LoopModalProps): ReactNode {
	const load = useAgentState(sessionId);
	return (
		<Modal title="Loop" onClose={onClose}>
			<LoopModalBody sessionId={sessionId} load={load} notify={notify} />
		</Modal>
	);
}

interface LoopModalBodyProps {
	sessionId: string;
	load: AgentStateLoad;
	notify(level: Notice["level"], message: string): void;
}

function LoopModalBody({ sessionId, load, notify }: LoopModalBodyProps): ReactNode {
	const [prompt, setPrompt] = useState("");
	const [limitText, setLimitText] = useState("");
	const [condition, setCondition] = useState("");
	const [until, setUntil] = useState(false);
	const [pending, setPending] = useState(false);

	const loop = load.state?.loop ?? null;

	const act = (
		action: Extract<LoopAction, "enable" | "disable" | "pause" | "resume">,
		overrides: {
			prompt?: string;
			limit?: LoopLimit;
			condition?: { command: string; until: boolean };
		} = {},
	): void => {
		setPending(true);
		void postLoop(sessionId, { action, ...overrides }).then(
			result => {
				setPending(false);
				load.refresh();
				if (action === "enable" && result !== null) notify("info", `loop ${result.state}`);
				else if (action === "disable") notify("info", "loop disabled");
				else if (action === "pause") notify("info", "loop paused");
				else if (action === "resume") notify("info", `loop ${result?.state ?? "running"}`);
			},
			(err: unknown) => {
				setPending(false);
				notify("error", errorText(err));
			},
		);
	};

	const enable = (): void => {
		const text = prompt.trim();
		if (!text) {
			notify("warning", "a prompt is required");
			return;
		}
		const trimmed = limitText.trim();
		const limit = trimmed === "" ? undefined : parseLoopLimit(trimmed);
		if (trimmed !== "" && limit === null) {
			notify("warning", "limit must be an iteration count (10) or a duration (10m, 1h30m)");
			return;
		}
		const command = condition.trim();
		act("enable", {
			prompt: text,
			...(limit ? { limit } : {}),
			...(command ? { condition: { command, until } } : {}),
		});
	};

	if (!load.state && load.loading) {
		return (
			<p className="hb-busy">
				<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading loop…
			</p>
		);
	}
	if (!load.state) {
		return (
			<div className="hb-modal-error" role="alert">
				{load.error ?? "agent state unavailable"}
			</div>
		);
	}

	return (
		<>
			<section className="hb-modal-section">
				<h3 className="hb-card-title">Status</h3>
				{loop === null ? (
					<p className="hb-empty">no loop — configure one below</p>
				) : (
					<LoopStatusCard loop={loop} />
				)}
			</section>

			<section className="hb-modal-section">
				<h3 className="hb-card-title">Prompt</h3>
				<textarea
					className="sh-input hb-textarea"
					value={prompt}
					onChange={e => setPrompt(e.target.value)}
					placeholder="sent again after every turn…"
					rows={3}
					disabled={pending}
				/>
			</section>

			<section className="hb-modal-section">
				<h3 className="hb-card-title">Limit</h3>
				<input
					className="sh-input"
					value={limitText}
					onChange={e => setLimitText(e.target.value)}
					placeholder="iterations or duration — 10, 10m, 1h30m (optional)"
					spellCheck={false}
					autoComplete="off"
					disabled={pending}
					aria-label="loop limit"
				/>
			</section>

			<section className="hb-modal-section">
				<h3 className="hb-card-title">Condition</h3>
				<div className="hb-modal-row">
					<input
						className="sh-input"
						value={condition}
						onChange={e => setCondition(e.target.value)}
						placeholder="shell command (optional)"
						spellCheck={false}
						autoComplete="off"
						disabled={pending}
						aria-label="loop condition command"
					/>
					<select
						className="sh-input hb-loop-until"
						value={until ? "until" : "while"}
						onChange={e => setUntil(e.target.value === "until")}
						disabled={pending || condition.trim() === ""}
						aria-label="loop condition polarity"
					>
						<option value="while">while it fails</option>
						<option value="until">until it passes</option>
					</select>
				</div>
			</section>

			<div className="hb-ops-actions">
				<button type="button" className="sh-btn" onClick={enable} disabled={pending}>
					Enable
				</button>
				<button type="button" className="sh-btn" onClick={() => act("disable")} disabled={loop === null || pending}>
					Disable
				</button>
				<button
					type="button"
					className="sh-btn"
					onClick={() => act("pause")}
					disabled={loop === null || loop.state === "paused" || pending}
				>
					Pause
				</button>
				<button
					type="button"
					className="sh-btn"
					onClick={() => act("resume")}
					disabled={loop === null || loop.state !== "paused" || pending}
				>
					Resume
				</button>
				{pending && <LoaderCircle size={13} className="hb-spin" aria-label="working" />}
			</div>
			{load.error && (
				<div className="hb-modal-error" role="alert">
					{load.error}
				</div>
			)}
			<p className="hb-card-note">
				Enable re-configures a running loop. The condition command runs before each iteration: the loop continues while
				it fails, and stops once it passes.
			</p>
		</>
	);
}

function LoopStatusCard({ loop }: { loop: LoopStatus }): ReactNode {
	return (
		<div className="hb-loop-status">
			<div className="hb-goal-meta">
				<span className={`hb-goal-badge hb-loop-${loop.state}`}>{loop.state}</span>
				{loop.limit?.kind === "iterations" && (
					<span className="hb-goal-tokens">
						{loop.limit.iterationsLeft !== undefined
							? `${loop.limit.iterationsLeft} of ${loop.limit.iterations} iterations left`
							: `${loop.limit.iterations} iterations`}
					</span>
				)}
				{loop.limit?.kind === "duration" && (
					<span className="hb-goal-tokens">
						{fmtDuration(loop.limit.durationMs)}
						{loop.limit.deadlineMs !== undefined ? ` · ends ${new Date(loop.limit.deadlineMs).toLocaleTimeString()}` : ""}
					</span>
				)}
			</div>
			{loop.prompt && <div className="hb-loop-prompt">{loop.prompt}</div>}
			{loop.condition && (
				<div className="hb-loop-condition">
					{loop.condition.until ? "until" : "while"} <code>{loop.condition.command}</code>
				</div>
			)}
		</div>
	);
}
