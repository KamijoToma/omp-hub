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
