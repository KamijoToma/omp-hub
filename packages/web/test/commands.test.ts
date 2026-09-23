/**
 * Slash-command routing (docs/protocol.md §6): leading-slash detection, the
 * command table, unknown-command notices, palette matching, and the composer
 * interception wrapper. UI-free — every command reaches the surface through a
 * stubbed {@link CommandContext}.
 */
import { describe, expect, test } from "bun:test";
import type { CommandContext, ModalKind } from "../src/hub/commands";
import {
	COMMANDS,
	commandQuery,
	createComposerClient,
	dumpFileName,
	matchCommands,
	parseCommand,
	parseCompactArgs,
	parseExtendedContextArg,
	parseLoopLimit,
	routeComposerText,
	transcriptJsonl,
	UNKNOWN_COMMAND_MESSAGE,
} from "../src/hub/commands";
import type { GuestClient, Notice } from "../src/lib/client";
import type { SessionEntry } from "../src/lib/wire";

interface Trace {
	modals: ModalKind[];
	themes: number;
	paths: string[];
	dumps: number;
	notices: { level: Notice["level"]; message: string }[];
	compacts: unknown[];
	clears: number;
	news: number;
	retries: number;
	extendedContext: (boolean | undefined)[];
	todosShown: number;
}

function makeContext(): { ctx: CommandContext; trace: Trace } {
	const trace: Trace = {
		modals: [],
		themes: 0,
		paths: [],
		dumps: 0,
		notices: [],
		compacts: [],
		clears: 0,
		news: 0,
		retries: 0,
		extendedContext: [],
		todosShown: 0,
	};
	return {
		trace,
		ctx: {
			openModal: kind => trace.modals.push(kind),
			toggleTheme: () => {
				trace.themes += 1;
			},
			navigate: path => trace.paths.push(path),
			downloadDump: () => {
				trace.dumps += 1;
			},
			notify: (level, message) => trace.notices.push({ level, message }),
			compactSession: request => trace.compacts.push(request),
			clearContext: () => {
				trace.clears += 1;
			},
			startNewSession: () => {
				trace.news += 1;
			},
			retrySession: () => {
				trace.retries += 1;
			},
			setExtendedContext: enabled => trace.extendedContext.push(enabled),
			showTodos: () => {
				trace.todosShown += 1;
			},
		},
	};
}

/** Stand-in for `GuestClient`; the private field proves the wrapper keeps the receiver brand. */
class FakeClient {
	readonly #sent: string[] = [];

	sendPrompt(text: string): void {
		this.#sent.push(text);
	}

	sent(): string[] {
		return this.#sent;
	}

	sendAbort(): string {
		return `abort:${this.#sent.length}`;
	}
}

describe("composer routing", () => {
	test("plain text is passed through and never touches the command table", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("fix the failing test", ctx)).toBe("passthrough");

		expect(trace).toEqual({
			modals: [],
			themes: 0,
			paths: [],
			dumps: 0,
			notices: [],
			compacts: [],
			clears: 0,
			news: 0,
			retries: 0,
			extendedContext: [],
			todosShown: 0,
		});
	});

	test("only a leading slash starts a command", () => {
		const { ctx } = makeContext();

		expect(routeComposerText("explain src/a/b.ts", ctx)).toBe("passthrough");
		expect(routeComposerText("what does /model do?", ctx)).toBe("passthrough");
		expect(routeComposerText("https://hub/join", ctx)).toBe("passthrough");
		expect(routeComposerText("\nsecond line", ctx)).toBe("passthrough");
		expect(routeComposerText("/model", ctx)).toBe("ran");
		expect(routeComposerText("  /model", ctx)).toBe("ran");
	});

	test("the table covers exactly the §6 commands", () => {
		expect(COMMANDS.map(cmd => cmd.name)).toEqual([
			"model",
			"thinking",
			"rewind",
			"compact",
			"clear",
			"new",
			"retry",
			"todo",
			"goal",
			"loop",
			"extended-context",
			"settings",
			"collab",
			"theme",
			"dump",
			"leave",
			"help",
		]);
	});

	test("every command reaches its surface hook", () => {
		const cases: { text: string; check(trace: Trace): void }[] = [
			{ text: "/model", check: t => expect(t.modals).toEqual(["model"]) },
			{ text: "/MODEL", check: t => expect(t.modals).toEqual(["model"]) },
			{ text: "/thinking", check: t => expect(t.modals).toEqual(["thinking"]) },
			{ text: "/rewind", check: t => expect(t.modals).toEqual(["rewind"]) },
			{ text: "/compact", check: t => expect(t.compacts).toEqual([{}]) },
			{ text: "/clear", check: t => expect(t.clears).toBe(1) },
			{ text: "/new", check: t => expect(t.news).toBe(1) },
			{ text: "/retry", check: t => expect(t.retries).toBe(1) },
			{ text: "/todo", check: t => expect(t.todosShown).toBe(1) },
			{ text: "/goal", check: t => expect(t.modals).toEqual(["goal"]) },
			{ text: "/loop", check: t => expect(t.modals).toEqual(["loop"]) },
			{ text: "/extended-context", check: t => expect(t.extendedContext).toEqual([undefined]) },
			{ text: "/settings", check: t => expect(t.modals).toEqual(["settings"]) },
			{ text: "/collab", check: t => expect(t.modals).toEqual(["links"]) },
			{ text: "/theme", check: t => expect(t.themes).toBe(1) },
			{ text: "/dump", check: t => expect(t.dumps).toBe(1) },
			{ text: "/leave", check: t => expect(t.paths).toEqual(["/"]) },
			{ text: "/help", check: t => expect(t.modals).toEqual(["help"]) },
		];

		for (const { text, check } of cases) {
			const { ctx, trace } = makeContext();
			expect(routeComposerText(text, ctx)).toBe("ran");
			expect(trace.notices).toEqual([]);
			check(trace);
		}
	});

	test("compact arguments split into mode + instructions", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/compact soft clean up the auth module", ctx)).toBe("ran");
		expect(trace.compacts).toEqual([{ mode: "soft", instructions: "clean up the auth module" }]);

		const bare = makeContext();
		expect(routeComposerText("/compact summarize the session so far", bare.ctx)).toBe("ran");
		expect(bare.trace.compacts).toEqual([{ instructions: "summarize the session so far" }]);

		const modeOnly = makeContext();
		expect(routeComposerText("/compact remote", modeOnly.ctx)).toBe("ran");
		expect(modeOnly.trace.compacts).toEqual([{ mode: "remote" }]);
	});

	test("snapcompact rejects instructions locally without dispatching", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/compact snapcompact keep the plan", ctx)).toBe("ran");

		expect(trace.compacts).toEqual([]);
		expect(trace.notices).toEqual([{ level: "warning", message: "snapcompact takes no instructions" }]);
	});

	test("extended-context accepts on/off and passes the rest through as a toggle", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/extended-context on", ctx)).toBe("ran");
		expect(routeComposerText("/extended-context off", ctx)).toBe("ran");
		expect(routeComposerText("/EXTENDED-CONTEXT ON", ctx)).toBe("ran");
		expect(routeComposerText("/extended-context sometimes", ctx)).toBe("ran");

		expect(trace.extendedContext).toEqual([true, false, true, undefined]);
		expect(trace.notices).toEqual([]);
	});

	test("unknown slash words are noticed and report themselves as consumed", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/rm -rf /", ctx)).toBe("unknown");
		expect(routeComposerText("/models", ctx)).toBe("unknown");

		expect(trace.modals).toEqual([]);
		expect(trace.notices).toEqual([
			{ level: "warning", message: UNKNOWN_COMMAND_MESSAGE },
			{ level: "warning", message: UNKNOWN_COMMAND_MESSAGE },
		]);
	});

	test("a bare slash is a draft, not a command", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/", ctx)).toBe("ignored");
		expect(routeComposerText("   /   ", ctx)).toBe("ignored");

		expect(trace.notices).toEqual([]);
	});

	test("parseCommand splits the command word from its arguments", () => {
		expect(parseCommand("fix the bug")).toBeNull();
		expect(parseCommand("/")).toBeNull();
		expect(parseCommand("  /  ")).toBeNull();
		expect(parseCommand("/model")).toEqual({ name: "model", args: "" });
		expect(parseCommand("  /Model   openai/gpt-5.1  ")).toEqual({ name: "model", args: "openai/gpt-5.1" });
		expect(parseCommand("/thinking high")).toEqual({ name: "thinking", args: "high" });
	});

	test("palette query and matching", () => {
		expect(commandQuery("")).toBeNull();
		expect(commandQuery("hi /model")).toBeNull();
		expect(commandQuery("/")).toBe("");
		expect(commandQuery("/mo")).toBe("mo");
		expect(commandQuery("/model openai")).toBe("model");

		expect(matchCommands(null)).toEqual([]);
		expect(matchCommands("").map(cmd => cmd.name)).toEqual(COMMANDS.map(cmd => cmd.name));
		expect(matchCommands("th").map(cmd => cmd.name)).toEqual(["thinking", "theme"]);
		expect(matchCommands("se").map(cmd => cmd.name)).toEqual(["settings"]);
		expect(matchCommands("zz")).toEqual([]);
	});
});

describe("session-op argument parsers", () => {
	test("parseCompactArgs splits a leading mode from the instructions", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   ")).toEqual({});
		expect(parseCompactArgs("remote")).toEqual({ mode: "remote" });
		expect(parseCompactArgs("  SOFT   focus on the failing tests  ")).toEqual({
			mode: "soft",
			instructions: "focus on the failing tests",
		});
		// An unknown first word is instructions, not a mode — the whole text.
		expect(parseCompactArgs("summarize the auth work")).toEqual({ instructions: "summarize the auth work" });
		expect(parseCompactArgs("softly summarize")).toEqual({ instructions: "softly summarize" });
	});

	test("parseCompactArgs rejects snapcompact focus text", () => {
		expect(parseCompactArgs("snapcompact")).toEqual({ mode: "snapcompact" });
		expect(parseCompactArgs("snapcompact archive this")).toEqual({ error: "snapcompact takes no instructions" });
	});

	test("parseExtendedContextArg maps on/off and defaults to a toggle", () => {
		expect(parseExtendedContextArg("")).toBeUndefined();
		expect(parseExtendedContextArg("on")).toBe(true);
		expect(parseExtendedContextArg("OFF")).toBe(false);
		expect(parseExtendedContextArg("  on  ")).toBe(true);
		expect(parseExtendedContextArg("maybe")).toBeUndefined();
	});

	test("parseLoopLimit reads iteration counts", () => {
		expect(parseLoopLimit("10")).toEqual({ kind: "iterations", iterations: 10 });
		expect(parseLoopLimit(" 1 ")).toEqual({ kind: "iterations", iterations: 1 });
		expect(parseLoopLimit("0")).toBeNull();
		expect(parseLoopLimit("-5")).toBeNull();
		expect(parseLoopLimit("1.5")).toBeNull();
	});

	test("parseLoopLimit reads compact and compound durations", () => {
		expect(parseLoopLimit("10m")).toEqual({ kind: "duration", durationMs: 600_000 });
		expect(parseLoopLimit("90s")).toEqual({ kind: "duration", durationMs: 90_000 });
		expect(parseLoopLimit("2h")).toEqual({ kind: "duration", durationMs: 7_200_000 });
		expect(parseLoopLimit("1h30m")).toEqual({ kind: "duration", durationMs: 5_400_000 });
		expect(parseLoopLimit("10 minutes")).toBeNull();
	});

	test("parseLoopLimit rejects junk and unknown units", () => {
		expect(parseLoopLimit("")).toBeNull();
		expect(parseLoopLimit("abc")).toBeNull();
		expect(parseLoopLimit("10x")).toBeNull();
		expect(parseLoopLimit("1.5h")).toBeNull();
		expect(parseLoopLimit("10m5")).toBeNull();
	});
});

describe("transcript dump", () => {
	const entries = [
		{ id: "e1", parentId: null, timestamp: "2026-09-23T10:00:00.000Z", type: "message" },
		{ id: "e2", parentId: "e1", timestamp: "2026-09-23T10:00:01.000Z", type: "message" },
	] as unknown as readonly SessionEntry[];

	test("dumps one JSONL row per entry", () => {
		expect(transcriptJsonl([])).toBe("");
		expect(transcriptJsonl(entries)).toBe(`${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n`);
	});

	test("names the file after the session and the dump time", () => {
		const at = new Date("2026-09-23T12:34:56.789Z");

		expect(dumpFileName("demo session/2", at)).toBe("demo-session-2-2026-09-23T12-34-56-789Z.jsonl");
		expect(dumpFileName("   ", at)).toBe("session-2026-09-23T12-34-56-789Z.jsonl");
	});
});

describe("composer client wrapper", () => {
	test("only sendPrompt is intercepted; every other member stays live", () => {
		const client = new FakeClient();
		const { ctx, trace } = makeContext();
		const wrapped = createComposerClient(client as unknown as GuestClient, text => {
			return routeComposerText(text, ctx) !== "passthrough";
		});

		wrapped.sendPrompt("explain the diff");
		wrapped.sendPrompt("/leave");
		wrapped.sendPrompt("/nope");
		wrapped.sendPrompt("/");

		expect(client.sent()).toEqual(["explain the diff"]);
		expect(trace.paths).toEqual(["/"]);
		expect(trace.notices).toEqual([{ level: "warning", message: UNKNOWN_COMMAND_MESSAGE }]);
		// Inherited methods keep working through the wrapper: `Object.create(client)`
		// would drop the private-field brand and throw here.
		const probe = wrapped as unknown as FakeClient;
		expect(probe.sent()).toEqual(["explain the diff"]);
		expect(probe.sendAbort()).toBe("abort:1");
	});
});
