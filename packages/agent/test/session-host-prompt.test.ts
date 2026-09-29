/**
 * `prompt` session command (protocol 0.8.0): blank text is rejected with the
 * standard cmd error shape; valid text reaches `session.prompt()` verbatim and
 * its accept answer is returned. The session is a stub — no SDK, no LLM.
 */

import { expect, test } from "bun:test";
import { type CommandFrame, executeCommand } from "../src/session-host";

/** Minimal AgentSession stand-in covering the prompt surface. */
function stubSession() {
	const prompts: string[] = [];
	return {
		prompts,
		session: {
			prompt: async (text: string) => {
				prompts.push(text);
				return true;
			},
		} as never,
	};
}

const deps = {} as never;
const loop = {} as never;

function frame(text: string | undefined): CommandFrame {
	return { t: "cmd", reqId: "r1", cmd: "prompt", ...(text === undefined ? {} : { text }) };
}

test("prompt rejects blank or missing text with the standard error shape", async () => {
	for (const text of [undefined, "", "   ", "\n\t "]) {
		const { session } = stubSession();
		await expect(executeCommand(session, frame(text), deps, loop)).rejects.toThrow(
			"prompt requires non-blank text",
		);
	}
});

test("prompt delivers the text to session.prompt and returns accepted", async () => {
	const { session, prompts } = stubSession();
	const result = await executeCommand(session, frame("run the tests"), deps, loop);
	expect(result).toEqual({ accepted: true });
	expect(prompts).toEqual(["run the tests"]);
});

test("human prompt acknowledges scheduling before a long model turn completes", async () => {
	const turn = Promise.withResolvers<boolean>();
	let submitted = false;
	const session = {
		prompt: () => { submitted = true; return turn.promise; },
		emitNotice: () => {},
	} as never;
	const runtime = { log: { error: () => {} } } as never;
	expect(await executeCommand(session, frame("run a long task"), runtime, loop)).toEqual({ accepted: true });
	expect(submitted).toBe(true);
	turn.resolve(true);
});

test("human prompt while a turn is active queues as a follow-up rather than failing busy", async () => {
	let queued = false;
	const session = {
		isStreaming: true,
		async prompt(_text: string, options?: { streamingBehavior?: string }) {
			if (options?.streamingBehavior !== "followUp") throw new Error("Agent is busy");
			queued = true;
			return true;
		},
	} as never;
	expect(await executeCommand(session, frame("new instruction"), deps, loop)).toEqual({ accepted: true });
	expect(queued).toBe(true);
});

test("fleet message modes schedule without waiting for worker turn completion", async () => {
	const turn = Promise.withResolvers<void>();
	const calls: string[] = [];
	const session = {
		isStreaming: false,
		prompt: async (text: string) => { calls.push(`start:${text}`); await turn.promise; return true; },
		steer: async (text: string) => { calls.push(`steer:${text}`); },
		followUp: async (text: string) => { calls.push(`follow_up:${text}`); },
	} as never;
	const runtime = { log: { error: () => {} } } as never;
	const send = (messageMode: "start" | "steer" | "follow_up") =>
		executeCommand(session, { t: "cmd", reqId: "r", cmd: "fleet-message", messageMode, text: "instruction" }, runtime, loop);
	expect(await send("start")).toMatchObject({ scheduled: true, operationId: expect.any(String) });
	expect(calls).toEqual(["start:instruction"]);
	expect(await send("steer")).toMatchObject({ scheduled: true, operationId: expect.any(String) });
	expect(await send("follow_up")).toMatchObject({ scheduled: true, operationId: expect.any(String) });
	expect(calls).toEqual(["start:instruction", "steer:instruction", "follow_up:instruction"]);
	turn.resolve();
});

test("interrupt withdraws queued work before abort then starts replacement only after abort settles", async () => {
	const abort = Promise.withResolvers<void>();
	const calls: string[] = [];
	const session = {
		clearQueue: () => { calls.push("clear"); },
		abort: async () => { calls.push("abort"); await abort.promise; },
		prompt: async (text: string) => { calls.push(`replace:${text}`); return true; },
	} as never;
	const runtime = { log: { error: () => {} } } as never;
	expect(await executeCommand(session, {
		t: "cmd", reqId: "r", cmd: "fleet-interrupt", clearQueue: true, text: "new task",
	}, runtime, loop)).toMatchObject({ scheduled: true, operationId: expect.any(String) });
	expect(calls).toEqual(["clear", "abort"]);
	abort.resolve();
	const deadline = Date.now() + 1000;
	while (!calls.includes("replace:new task")) {
		if (Date.now() > deadline) throw new Error(`replacement did not start after abort: ${calls.join(", ")}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	expect(calls).toEqual(["clear", "abort", "replace:new task"]);
});

test("late worker dispatch failures are correlated back to the fleet controller", async () => {
	const gate = Promise.withResolvers<void>();
	const events: Array<{ kind: string; operationId: string; error: string }> = [];
	const session = {
		isStreaming: false,
		async prompt() { await gate.promise; throw new Error("provider rejected request"); },
		emitNotice: () => {},
	} as never;
	const runtime = { log: { error: () => {} }, emitFleetEvent: (event: { kind: string; operationId: string; error: string }) => events.push(event) } as never;
	const scheduled = await executeCommand(session, { t: "cmd", reqId: "r", cmd: "fleet-message", messageMode: "start", text: "run" }, runtime, loop);
	if (!scheduled || typeof scheduled !== "object" || !("operationId" in scheduled) || typeof scheduled.operationId !== "string") {
		throw new Error("scheduled fleet message lacked an operation id");
	}
	gate.resolve();
	const deadline = Date.now() + 1000;
	while (events.length === 0) {
		if (Date.now() > deadline) throw new Error("late failure was not delivered");
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	expect(events[0]).toEqual({ kind: "operation_failed", error: "provider rejected request", operationId: scheduled.operationId });
});

test("replacement refuses to race pre-existing queued work without explicit clearing", async () => {
	const calls: string[] = [];
	const session = {
		queuedMessageCount: 1,
		clearQueue: () => { calls.push("clear"); },
		abort: async () => { calls.push("abort"); },
	} as never;
	await expect(executeCommand(session, { t: "cmd", reqId: "r", cmd: "fleet-interrupt", text: "replace" }, deps, loop))
		.rejects.toThrow("replacement has queued work");
	expect(calls).toEqual([]);
});
