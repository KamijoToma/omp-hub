/**
 * Session loop controller (contract §2): prompt repetition after terminal
 * turns, budget/condition gates, and pause/resume — driven through a stub
 * session, so no SDK is loaded. Bun's fake timers advance the controller's
 * defer/schedule timers deterministically; the injected `now()` drives the
 * duration budget, so no test waits on the wall clock.
 */

import { expect, test, vi } from "bun:test";
import { SessionLoop, type LoopConditionConfig, type LoopConditionVerdict, type LoopControllerDeps, type LoopSession } from "../src/session-loop";

/** Stub session: mutable busy flags, recorded prompts, manual agent_end events. */
class FakeLoopSession implements LoopSession {
	isStreaming = false;
	isCompacting = false;
	hasPostPromptWork = false;
	prompts: string[] = [];
	readonly cwd = "/tmp/project";
	readonly sessionId = "sess-loop-test";
	readonly conditionTimeoutMsValue = 42_000;
	#listeners = new Set<(event: { type: string; isTerminal?: boolean }) => void>();

	prompt(text: string): Promise<void> {
		this.prompts.push(text);
		return Promise.resolve();
	}

	subscribe(listener: (event: { type: string; isTerminal?: boolean }) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	conditionTimeoutMs(): number {
		return this.conditionTimeoutMsValue;
	}

	/** Deliver one agent event to the controller's subscription. */
	agentEnd(isTerminal?: boolean): void {
		for (const listener of [...this.#listeners]) listener({ type: "agent_end", isTerminal });
	}
}

interface Harness {
	session: FakeLoopSession;
	loop: SessionLoop;
	evaluations: { condition: LoopConditionConfig; options: { cwd?: string; timeoutMs: number; sessionId: string } }[];
	logs: { level: string; message: string }[];
	setTime(ms: number): void;
	/** Fire every fake timer scheduled ≤ now, then flush the queued continuations. */
	tick(ms?: number): Promise<void>;
}

/** Controller wired to a stub session, 1 ms defer tick, injectable clock. */
function makeHarness(verdicts: LoopConditionVerdict[] = [{ kind: "continue" }]): Harness {
	const session = new FakeLoopSession();
	const evaluations: Harness["evaluations"] = [];
	const logs: Harness["logs"] = [];
	let nowMs = 0;
	const deps: LoopControllerDeps = {
		session,
		evaluate: (condition, options) => {
			evaluations.push({ condition, options: { cwd: options.cwd, timeoutMs: options.timeoutMs, sessionId: options.sessionId } });
			const verdict = verdicts[Math.min(evaluations.length - 1, verdicts.length - 1)];
			return Promise.resolve(verdict ?? { kind: "continue" });
		},
		now: () => nowMs,
		retryDelayMs: 1,
		log: {
			debug: message => void logs.push({ level: "debug", message }),
			info: message => void logs.push({ level: "info", message }),
			warn: message => void logs.push({ level: "warn", message }),
			error: message => void logs.push({ level: "error", message }),
		},
	};
	return {
		session,
		loop: new SessionLoop(deps),
		evaluations,
		logs,
		setTime: ms => {
			nowMs = ms;
		},
		tick: async ms => {
			vi.advanceTimersByTime(ms ?? 0);
			// The iterate continuation is async; drain the microtasks it queued.
			for (let i = 0; i < 10; i++) await Promise.resolve();
		},
	};
}

test("a disabled loop ignores terminal agent_end and reports null status", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.session.agentEnd(true);
		await h.tick(1);
		expect(h.session.prompts).toEqual([]);
		expect(h.loop.status()).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test("enable with a prompt runs the first iteration without waiting for a turn", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.loop.enable({ prompt: "keep going" });
		await h.tick();
		expect(h.session.prompts).toEqual(["keep going"]);
		expect(h.loop.status()?.state).toBe("running");
	} finally {
		vi.useRealTimers();
	}
});

test("only terminal agent_end events trigger the next iteration", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.loop.enable({ prompt: "again", limit: { kind: "iterations", iterations: 3 } });
		await h.tick();

		// Scheduled continuations resume the session without ending the loop's turn.
		h.session.agentEnd(false);
		h.session.agentEnd(undefined);
		await h.tick(1);
		expect(h.session.prompts).toEqual(["again"]);

		h.session.agentEnd(true);
		await h.tick();
		expect(h.session.prompts).toEqual(["again", "again"]);
	} finally {
		vi.useRealTimers();
	}
});

test("a busy session defers the iteration until streaming, compaction, and post-prompt work end", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.session.isStreaming = true;
		h.loop.enable({ prompt: "later" });
		// Several retry ticks pass while each gate is up; nothing may run.
		for (let i = 0; i < 3; i++) await h.tick(1);
		expect(h.session.prompts).toEqual([]);

		h.session.isStreaming = false;
		h.session.isCompacting = true;
		for (let i = 0; i < 3; i++) await h.tick(1);
		expect(h.session.prompts).toEqual([]);

		h.session.isCompacting = false;
		h.session.hasPostPromptWork = true;
		for (let i = 0; i < 3; i++) await h.tick(1);
		expect(h.session.prompts).toEqual([]);

		h.session.hasPostPromptWork = false;
		await h.tick(1);
		expect(h.session.prompts).toEqual(["later"]);
	} finally {
		vi.useRealTimers();
	}
});

test("exhausted iteration budget disables the loop before the condition runs again", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness([{ kind: "continue" }]);
		h.loop.enable({ prompt: "work", limit: { kind: "iterations", iterations: 1 }, condition: { command: "true", until: false } });
		await h.tick();
		expect(h.session.prompts).toEqual(["work"]);
		expect(h.evaluations).toHaveLength(1);

		h.session.agentEnd(true);
		await h.tick();
		expect(h.loop.status()).toBeNull();
		expect(h.session.prompts).toHaveLength(1);
		// The budget check precedes the condition gate: no second evaluation.
		expect(h.evaluations).toHaveLength(1);
		expect(h.logs.some(line => line.level === "info" && line.message.includes("Loop limit reached."))).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("expired duration budget disables the loop", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.loop.enable({ prompt: "work", limit: { kind: "duration", durationMs: 1_000 } });
		await h.tick();
		expect(h.session.prompts).toEqual(["work"]);

		h.setTime(1_500);
		h.session.agentEnd(true);
		await h.tick();
		expect(h.loop.status()).toBeNull();
		expect(h.session.prompts).toHaveLength(1);
		expect(h.logs.some(line => line.level === "info" && line.message.includes("Loop time limit reached."))).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("a halting condition disables the loop and no prompt runs", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness([{ kind: "halt", message: "condition satisfied" }]);
		h.loop.enable({ prompt: "never", condition: { command: "test -z x", until: false } });
		await h.tick();
		expect(h.loop.status()).toBeNull();
		expect(h.session.prompts).toEqual([]);
		expect(h.evaluations).toHaveLength(1);
		expect(h.logs.some(line => line.level === "info" && line.message.includes("condition satisfied"))).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("condition evaluation receives the session cwd, id, and configured timeout", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness([{ kind: "aborted" }]);
		h.loop.enable({ prompt: "guarded", condition: { command: "check", until: true } });
		await h.tick();
		expect(h.evaluations[0]?.condition).toEqual({ command: "check", until: true });
		expect(h.evaluations[0]?.options).toEqual({
			cwd: h.session.cwd,
			sessionId: h.session.sessionId,
			timeoutMs: h.session.conditionTimeoutMsValue,
		});
		// An aborted verdict stops this iteration silently but keeps the loop armed.
		expect(h.session.prompts).toEqual([]);
		expect(h.loop.status()?.state).toBe("running");
	} finally {
		vi.useRealTimers();
	}
});

test("a continuing condition gates each iteration before the prompt runs", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness([{ kind: "continue" }, { kind: "continue" }, { kind: "halt", message: "done now" }]);
		h.loop.enable({ prompt: "gated", limit: { kind: "iterations", iterations: 5 }, condition: { command: "check", until: false } });
		await h.tick();
		expect(h.session.prompts).toEqual(["gated"]);
		expect(h.evaluations).toHaveLength(1);

		h.session.agentEnd(true);
		await h.tick();
		expect(h.session.prompts).toEqual(["gated", "gated"]);

		h.session.agentEnd(true);
		await h.tick();
		expect(h.loop.status()).toBeNull();
		expect(h.session.prompts).toHaveLength(2);
		expect(h.evaluations).toHaveLength(3);
		expect(h.logs.some(line => line.level === "info" && line.message.includes("done now"))).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("pause suspends iterations and resume continues them", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.session.isStreaming = true;
		h.loop.enable({ prompt: "resumable" });
		await h.tick(1);

		h.loop.pause();
		expect(h.loop.status()).toMatchObject({ state: "paused", prompt: "resumable" });
		// The pause drops the pending retry timer outright.
		expect(vi.getTimerCount()).toBe(0);

		// A turn ending while paused must not queue an iteration.
		h.session.isStreaming = false;
		h.session.agentEnd(true);
		await h.tick(1);
		expect(h.session.prompts).toEqual([]);

		h.loop.resume();
		await h.tick();
		expect(h.session.prompts).toEqual(["resumable"]);
		expect(h.loop.status()?.state).toBe("running");
	} finally {
		vi.useRealTimers();
	}
});

test("pause and resume on a disabled loop are no-ops", () => {
	const h = makeHarness();
	h.loop.pause();
	h.loop.resume();
	expect(h.loop.status()).toBeNull();
});

test("status exposes prompt, remaining budget, and condition", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.loop.enable({ prompt: "shaped", limit: { kind: "iterations", iterations: 3 }, condition: { command: "c", until: true } });
		expect(h.loop.status()).toEqual({
			state: "running",
			prompt: "shaped",
			limit: { kind: "iterations", iterations: 3, iterationsLeft: 3 },
			condition: { command: "c", until: true },
		});
		await h.tick();
		expect(h.loop.status()?.limit).toEqual({ kind: "iterations", iterations: 3, iterationsLeft: 2 });

		const clock = makeHarness();
		clock.loop.enable({ prompt: "timed", limit: { kind: "duration", durationMs: 5_000 } });
		expect(clock.loop.status()?.limit).toEqual({ kind: "duration", durationMs: 5_000, deadlineMs: 5_000 });

		// No prompt configured: the loop waits for the web's next enable.
		const waiting = makeHarness();
		waiting.loop.enable({});
		expect(waiting.loop.status()).toEqual({ state: "waiting" });
		await clock.tick(); // consume the clock harness's still-pending first iteration
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});

test("enable while enabled replaces the configuration and resets the budget", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.session.isStreaming = true;
		h.loop.enable({ prompt: "first", limit: { kind: "iterations", iterations: 3 } });
		h.loop.enable({ prompt: "second", limit: { kind: "iterations", iterations: 1 } });
		expect(h.loop.status()).toMatchObject({ prompt: "second", limit: { kind: "iterations", iterations: 1, iterationsLeft: 1 } });

		h.session.isStreaming = false;
		await h.tick(1);
		expect(h.session.prompts).toEqual(["second"]);
		h.session.agentEnd(true);
		await h.tick();
		expect(h.loop.status()).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test("invalid enable arguments throw and leave the loop unarmed", () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		expect(() => h.loop.enable({ prompt: "x", limit: { kind: "iterations", iterations: 0 } })).toThrow(/positive integer/);
		expect(() => h.loop.enable({ prompt: "x", limit: { kind: "duration", durationMs: -1 } })).toThrow(/positive number/);
		expect(() => h.loop.enable({ prompt: "x", limit: { kind: "bogus" } as never })).toThrow(/\{iterations\} or \{durationMs\}/);
		expect(() => h.loop.enable({ prompt: "x", condition: { command: "  ", until: false } })).toThrow(/requires a command/);
		expect(() => h.loop.enable({ prompt: "x", condition: { command: "c", until: "yes" as never } })).toThrow(/until must be a boolean/);
		expect(h.loop.status()).toBeNull();
		// `until` stays optional and defaults to `--while`; this enable succeeds.
		expect(() => h.loop.enable({ prompt: "x", condition: { command: "c" } })).not.toThrow();
		expect(h.loop.status()).toEqual({ state: "running", prompt: "x", condition: { command: "c", until: false } });
	} finally {
		vi.useRealTimers();
	}
});

test("dispose drops pending timers and the SDK subscription", async () => {
	vi.useFakeTimers();
	try {
		const h = makeHarness();
		h.session.isStreaming = true;
		h.loop.enable({ prompt: "doomed" });
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		h.loop.dispose();
		expect(vi.getTimerCount()).toBe(0);
		h.session.isStreaming = false;
		h.session.agentEnd(true);
		await h.tick(5);
		expect(h.session.prompts).toEqual([]);
		expect(h.loop.status()).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});
