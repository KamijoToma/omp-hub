/**
 * Session loop controller (protocol §4 `loop` cmd, contract §2) — the TUI loop
 * engine's host-side mirror, minus the vibe/compact/reset actions a headless
 * session has no use for. One instance per session: it re-submits the captured
 * prompt after each terminal turn until its budget runs out or a `--while`/
 * `--until` condition says the work is done.
 *
 * The SDK session is injected through a narrow structural interface so tests
 * can drive the engine with a stub; the SDK functions themselves are injected
 * too (session-host loads them lazily after the config boundary).
 */

import { errorMessage, createLogger, type Logger } from "./log";
import type { LoopConditionOptions, LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";

export type { LoopConditionOptions, LoopConditionVerdict };

/** Continue-condition as accepted on the wire: `until` optional, `false` (`--while`) implied. */
export interface LoopConditionInput {
	/** Shell command line, run through the user's configured shell. */
	command: string;
	/** `--until` (continue while the command fails) when true; `--while` when false. */
	until?: boolean;
}

/** Materialized continue-condition (`--while`/`--until`): a shell command whose exit status gates the next iteration. */
export interface LoopConditionConfig {
	/** Shell command line, run through the user's configured shell. */
	command: string;
	/** `--until` (continue while the command fails) when true; `--while` when false. */
	until: boolean;
}

/** Iteration/duration budget configured at enable time. */
export type { LoopLimitConfig } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { LoopLimitConfig } from "@oh-my-pi/pi-coding-agent/modes/loop-limit";

/** `loop` cmd result payload and `get-state` `loop` field. */
export interface LoopStatus {
	/** `paused` flag; otherwise prompt set → `running`, else `waiting` for one. */
	state: "waiting" | "running" | "paused";
	prompt?: string;
	limit?: { kind: "iterations"; iterations: number; iterationsLeft: number }
		| { kind: "duration"; durationMs: number; deadlineMs: number };
	condition?: LoopConditionConfig;
}

/** Enable options; mutating `enable` while enabled replaces all three. */
export interface LoopEnableOptions {
	prompt?: string;
	limit?: LoopLimitConfig;
	condition?: LoopConditionInput;
}

/** Session event subset the controller reacts to (rest of `AgentSessionEvent` is ignored). */
export interface LoopSessionEvent {
	type: string;
	isTerminal?: boolean;
}

/** Narrow `AgentSession` surface the controller touches — stub-friendly. */
export interface LoopSession {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly hasPostPromptWork: boolean;
	prompt(text: string): Promise<unknown>;
	subscribe(listener: (event: LoopSessionEvent) => void): () => void;
	getCwd(): string;
	getSessionId(): string | undefined;
	/** `loop.conditionTimeoutMs` setting, read at evaluation time. */
	conditionTimeoutMs(): number;
}

export interface LoopControllerDeps {
	session: LoopSession;
	/** One condition evaluation; the session-host injects the SDK implementation. */
	evaluate: (condition: LoopConditionConfig, options: LoopConditionOptions) => Promise<LoopConditionVerdict>;
	/** Wall clock, injectable for deterministic deadline tests. */
	now?: () => number;
	/** Deferred-retry interval while the session cannot accept a prompt. */
	retryDelayMs?: number;
	log?: Logger;
}

/** How long a blocked session defers before re-checking (contract §2). */
const DEFAULT_RETRY_DELAY_MS = 500;

/** Loop commands waiting on a busy session; logs like any other host component. */
const defaultLog = createLogger("loop");

/** Wire data arrives unvalidated (§4): reject bad budgets instead of arming a broken loop. */
function validateLimit(limit: LoopLimitConfig | undefined): LoopLimitConfig | undefined {
	if (limit === undefined) return undefined;
	if (typeof limit !== "object" || limit === null) throw new Error("loop limit must be {iterations} or {durationMs}");
	if (limit.kind === "iterations") {
		if (typeof limit.iterations !== "number" || !Number.isInteger(limit.iterations) || limit.iterations <= 0) {
			throw new Error(`loop limit iterations must be a positive integer, got ${JSON.stringify((limit as { iterations: unknown }).iterations)}`);
		}
		return { kind: "iterations", iterations: limit.iterations };
	}
	if (limit.kind === "duration") {
		if (typeof limit.durationMs !== "number" || !Number.isFinite(limit.durationMs) || limit.durationMs <= 0) {
			throw new Error(`loop limit durationMs must be a positive number, got ${JSON.stringify((limit as { durationMs: unknown }).durationMs)}`);
		}
		return { kind: "duration", durationMs: limit.durationMs };
	}
	throw new Error("loop limit must be {iterations} or {durationMs}");
}

/** Reject bad conditions; `until` stays optional and defaults to `--while`. */
function validateCondition(condition: LoopConditionInput | undefined): LoopConditionConfig | undefined {
	if (condition === undefined) return undefined;
	if (typeof condition !== "object" || condition === null || typeof condition.command !== "string" || !condition.command.trim()) {
		throw new Error("loop condition requires a command");
	}
	if (condition.until !== undefined && typeof condition.until !== "boolean") {
		throw new Error("loop condition until must be a boolean");
	}
	return { command: condition.command, until: condition.until === true };
}

export class SessionLoop {
	readonly #deps: LoopControllerDeps;
	readonly #now: () => number;
	readonly #retryDelayMs: number;
	readonly #log: Logger;
	#unsubscribe: () => void;
	#enabled = false;
	#paused = false;
	#prompt: string | undefined;
	#limit: LoopLimitConfig | undefined;
	#condition: LoopConditionConfig | undefined;
	/** Remaining iterations for a `{kind:"iterations"}` budget. */
	#iterationsLeft = 0;
	/** Expiry for a `{kind:"duration"}` budget. */
	#deadlineMs = 0;
	#pending: ReturnType<typeof setTimeout> | undefined;
	#conditionAbort: AbortController | undefined;
	/** Single-flight guard: one iteration decision at a time. */
	#iterating = false;

	constructor(deps: LoopControllerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.#log = deps.log ?? defaultLog;
		// Only a terminal `agent_end` is a turn end; scheduled continuations
		// (async job delivery) resume the session without finishing the loop's
		// previous iteration and must not trigger a new one.
		this.#unsubscribe = deps.session.subscribe(event => {
			if (event.type !== "agent_end" || event.isTerminal !== true) return;
			this.#schedule(0);
		});
	}

	/** Arm the loop (or replace the config of a live one) and kick the first iteration. */
	enable(options: LoopEnableOptions = {}): void {
		// Blank prompts mean "waiting for the next one", not an empty submission.
		const raw = options.prompt;
		const prompt = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
		const limit = validateLimit(options.limit);
		const condition = validateCondition(options.condition);
		this.#abortCondition();
		this.#enabled = true;
		this.#paused = false;
		this.#prompt = prompt;
		this.#limit = limit;
		this.#condition = condition;
		if (limit?.kind === "iterations") this.#iterationsLeft = limit.iterations;
		if (limit?.kind === "duration") this.#deadlineMs = this.#now() + limit.durationMs;
		// Mirror the TUI's inline-prompt behavior: an enable with a prompt runs
		// its first iteration as soon as the session can take it.
		if (prompt !== undefined) this.#schedule(0);
	}

	/** Stop and forget the loop; idempotent. */
	disable(reason = "Loop mode disabled."): void {
		if (!this.#enabled) return;
		this.#teardown();
		// Same text the TUI surfaces to the user (limit/condition messages ride in).
		this.#log.info(reason);
	}

	/** Keep the config, drop pending work; the next `enable`/`resume` continues. */
	pause(): void {
		if (!this.#enabled || this.#paused) return;
		this.#paused = true;
		this.#cancelTimer();
		this.#abortCondition();
	}

	resume(): void {
		if (!this.#enabled || !this.#paused) return;
		this.#paused = false;
		if (this.#prompt !== undefined) this.#schedule(0);
	}

	/** Current status, or null when disabled. */
	status(): LoopStatus | null {
		if (!this.#enabled) return null;
		const status: LoopStatus = {
			state: this.#paused ? "paused" : this.#prompt !== undefined ? "running" : "waiting",
		};
		if (this.#prompt !== undefined) status.prompt = this.#prompt;
		if (this.#limit?.kind === "iterations") {
			status.limit = { kind: "iterations", iterations: this.#limit.iterations, iterationsLeft: this.#iterationsLeft };
		} else if (this.#limit?.kind === "duration") {
			status.limit = { kind: "duration", durationMs: this.#limit.durationMs, deadlineMs: this.#deadlineMs };
		}
		if (this.#condition !== undefined) status.condition = { ...this.#condition };
		return status;
	}

	/** Drop timers and the SDK subscription; called on session shutdown. */
	dispose(): void {
		this.#enabled = false;
		this.#cancelTimer();
		this.#abortCondition();
		this.#unsubscribe();
	}

	#teardown(): void {
		this.#enabled = false;
		this.#paused = false;
		this.#prompt = undefined;
		this.#limit = undefined;
		this.#condition = undefined;
		this.#iterationsLeft = 0;
		this.#deadlineMs = 0;
		this.#cancelTimer();
		this.#abortCondition();
	}

	#cancelTimer(): void {
		if (this.#pending === undefined) return;
		clearTimeout(this.#pending);
		this.#pending = undefined;
	}

	#abortCondition(): void {
		this.#conditionAbort?.abort();
		this.#conditionAbort = undefined;
	}

	#schedule(delayMs: number): void {
		this.#cancelTimer();
		this.#pending = setTimeout(() => {
			this.#pending = undefined;
			void this.#iterate();
		}, delayMs);
	}

	async #iterate(): Promise<void> {
		if (this.#iterating) return;
		this.#iterating = true;
		try {
			const { session } = this.#deps;
			if (!this.#enabled || this.#paused || this.#prompt === undefined) return;
			const prompt = this.#prompt;
			// The TUI's auto-submit gate: a streaming/compacting turn or pending
			// post-prompt work means this iteration defers and retries later.
			if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) {
				this.#schedule(this.#retryDelayMs);
				return;
			}
			// An exhausted budget ends the loop before the condition runs: the
			// user's command must not execute one last time for nothing.
			if (this.#limit?.kind === "duration" && this.#now() >= this.#deadlineMs) {
				this.disable("Loop time limit reached.");
				return;
			}
			if (this.#limit?.kind === "iterations" && this.#iterationsLeft <= 0) {
				this.disable("Loop limit reached.");
				return;
			}
			if (this.#condition !== undefined && !(await this.#passesCondition())) return;
			// The condition gate awaited: config may be gone or REPLACED (enable
			// supersedes a pending gate, as in the TUI), and a turn may have
			// started meanwhile — the pre-await checks are stale.
			if (!this.#enabled || this.#paused || this.#prompt !== prompt) return;
			if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) {
				this.#schedule(this.#retryDelayMs);
				return;
			}
			if (this.#limit?.kind === "iterations") {
				if (this.#iterationsLeft <= 0) {
					this.disable("Loop limit reached.");
					return;
				}
				this.#iterationsLeft -= 1;
			}
			void session.prompt(prompt).catch(err => this.#log.error(`loop prompt failed: ${errorMessage(err)}`));
		} finally {
			this.#iterating = false;
		}
	}

	/**
	 * Evaluate the configured condition for one iteration. False when the
	 * iteration must not run: the condition said stop (loop disabled with the
	 * verdict's message), evaluation was aborted, or the loop was paused or
	 * stopped while the command was still running.
	 */
	async #passesCondition(): Promise<boolean> {
		const condition = this.#condition;
		if (condition === undefined) return true;
		// A prior evaluation can still be in flight when the next iteration
		// starts; abort it instead of leaking a child process nobody can stop.
		this.#abortCondition();
		const controller = new AbortController();
		this.#conditionAbort = controller;
		let verdict: LoopConditionVerdict;
		try {
			verdict = await this.#deps.evaluate(condition, {
				cwd: this.#deps.session.getCwd(),
				timeoutMs: this.#deps.session.conditionTimeoutMs(),
				signal: controller.signal,
				sessionId: this.#deps.session.getSessionId() ?? "hub-session",
			});
		} finally {
			if (this.#conditionAbort === controller) this.#conditionAbort = undefined;
		}
		if (!this.#enabled || this.#paused || this.#prompt === undefined) return false;
		if (verdict.kind === "continue") return true;
		if (verdict.kind === "aborted") return false;
		this.disable(verdict.message);
		return false;
	}
}
