/**
 * Slash-command syntax, unknown-command handling, palette matching, and the
 * composer interception wrapper without mounting the browser UI.
 */
import { describe, expect, test } from "bun:test";
import type { MachineSession } from "../src/hub/api";
import type { CommandContext, ModalKind } from "../src/hub/commands";
import {
	commandQuery,
	createComposerClient,
	dumpFileName,
	matchCommands,
	matchResumableSession,
	paletteCommandText,
	parseCommand,
	parseCompactArgs,
	parseExtendedContextArg,
	parsePlanArgs,
	parsePrewalkArgs,
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
	dumps: number;
	notices: { level: Notice["level"]; message: string }[];
	compacts: unknown[];
	shakes: string[];
	handoffs: (string | undefined)[];
	clears: number;
	news: number;
	renames: string[];
	titles: number;
	resumes: string[];
	retries: number;
	extendedContext: (boolean | undefined)[];
	prewalks: unknown[];
	plans: unknown[];
	advisorToggles: number;
	tiers: string[];
	pauses: number;
	cycles: number;
	roleCycles: number;
	todosShown: number;
}

function makeContext(): { ctx: CommandContext; trace: Trace } {
	const trace: Trace = {
		modals: [],
		themes: 0,
		dumps: 0,
		notices: [],
		compacts: [],
		shakes: [],
		handoffs: [],
		clears: 0,
		news: 0,
		renames: [],
		titles: 0,
		resumes: [],
		retries: 0,
		extendedContext: [],
		prewalks: [],
		plans: [],
		advisorToggles: 0,
		tiers: [],
		pauses: 0,
		cycles: 0,
		roleCycles: 0,
		todosShown: 0,
	};
	return {
		trace,
		ctx: {
			openModal: kind => trace.modals.push(kind),
			toggleTheme: () => {
				trace.themes += 1;
			},
			leaveSession: () => {},
			downloadDump: () => {
				trace.dumps += 1;
			},
			notify: (level, message) => trace.notices.push({ level, message }),
			compactSession: request => trace.compacts.push(request),
			shakeSession: mode => trace.shakes.push(mode),
			handoffSession: instructions => trace.handoffs.push(instructions),
			clearContext: () => {
				trace.clears += 1;
			},
			startNewSession: () => {
				trace.news += 1;
			},
			renameSession: name => {
				trace.renames.push(name);
			},
			generateTitle: () => {
				trace.titles += 1;
			},
			resumeSession: query => {
				trace.resumes.push(query);
			},
			retrySession: () => {
				trace.retries += 1;
			},
			setExtendedContext: enabled => trace.extendedContext.push(enabled),
			prewalkSession: request => trace.prewalks.push(request),
			planSession: request => trace.plans.push(request),
			toggleAdvisor: () => {
				trace.advisorToggles += 1;
			},
			setTier: tier => trace.tiers.push(tier),
			togglePause: () => {
				trace.pauses += 1;
			},
			cycleModel: () => {
				trace.cycles += 1;
			},
			cycleRoles: () => {
				trace.roleCycles += 1;
			},
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

	test("only a leading slash starts a command", () => {
		const { ctx } = makeContext();

		expect(routeComposerText("explain src/a/b.ts", ctx)).toBe("passthrough");
		expect(routeComposerText("what does /model do?", ctx)).toBe("passthrough");
		expect(routeComposerText("https://hub/join", ctx)).toBe("passthrough");
		expect(routeComposerText("\nsecond line", ctx)).toBe("passthrough");
		expect(routeComposerText("/model", ctx)).toBe("ran");
		expect(routeComposerText("  /model", ctx)).toBe("ran");
	});

	test("the TUI continue shortcut ('.' or 'c') retries instead of prompting", () => {
		const dot = makeContext();
		expect(routeComposerText(".", dot.ctx)).toBe("ran");
		expect(dot.trace.retries).toBe(1);

		const c = makeContext();
		expect(routeComposerText("c", c.ctx)).toBe("ran");
		expect(c.trace.retries).toBe(1);

		// The Composer trims before routing; padded input still shortcuts.
		const padded = makeContext();
		expect(routeComposerText(" . ", padded.ctx)).toBe("ran");
		expect(padded.trace.retries).toBe(1);
	});

	test("the retry shortcut is exact — lookalikes stay plain prompts", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("C", ctx)).toBe("passthrough");
		expect(routeComposerText("cat", ctx)).toBe("passthrough");
		expect(routeComposerText("sure.", ctx)).toBe("passthrough");

		expect(trace.retries).toBe(0);
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

	test("shake picks a mode word and defaults bare calls to elide", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/shake", ctx)).toBe("ran");
		expect(trace.shakes).toEqual(["elide"]);

		const images = makeContext();
		expect(routeComposerText("/shake images", images.ctx)).toBe("ran");
		expect(images.trace.shakes).toEqual(["images"]);

		const thinking = makeContext();
		expect(routeComposerText("/shake THINKING", thinking.ctx)).toBe("ran");
		expect(thinking.trace.shakes).toEqual(["thinking"]);

		// Multi-word args are not instructions here: only one mode word exists.
		const extra = makeContext();
		expect(routeComposerText("/shake images now", extra.ctx)).toBe("ran");
		expect(extra.trace.shakes).toEqual([]);
		expect(extra.trace.notices).toEqual([
			{ level: "warning", message: 'Unknown /shake mode "images now". Use elide, images, or thinking.' },
		]);
	});

	test("handoff forwards focus instructions and dispatches bare calls", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/handoff capture the auth refactor state", ctx)).toBe("ran");
		expect(trace.handoffs).toEqual(["capture the auth refactor state"]);

		const padded = makeContext();
		expect(routeComposerText("/handoff   ", padded.ctx)).toBe("ran");
		expect(padded.trace.handoffs).toEqual([undefined]);
	});

	test("rename forwards the new name and keeps inner whitespace", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/rename Release 1.0 — hotfix train", ctx)).toBe("ran");
		expect(trace.renames).toEqual(["Release 1.0 — hotfix train"]);
		expect(trace.notices).toEqual([]);
	});

	test("bare rename generates a title instead of printing usage", () => {
		const { ctx, trace } = makeContext();

		expect(routeComposerText("/rename", ctx)).toBe("ran");
		expect(routeComposerText("/rename   ", ctx)).toBe("ran");
		expect(trace.titles).toBe(2);
		expect(trace.renames).toEqual([]);
		expect(trace.notices).toEqual([]);
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
		expect(matchCommands("th").map(cmd => cmd.name)).toEqual(["thinking", "theme"]);
		expect(matchCommands("se").map(cmd => cmd.name)).toEqual(["sessions", "settings"]);
		expect(matchCommands("zz")).toEqual([]);
	});

	test("palette activation keeps typed args (regression: Enter dropped them)", () => {
		// `/rename my title` + Enter on the /rename row must run with the args.
		expect(paletteCommandText("/rename my title", "rename")).toBe("/rename my title");
		expect(paletteCommandText("/rename", "rename")).toBe("/rename");
		// A partial word completes, keeping any args typed after it.
		expect(paletteCommandText("/rena my title", "rename")).toBe("/rename my title");
		expect(paletteCommandText("/rena", "rename")).toBe("/rename");
		// A bare `/` completes to the highlighted row.
		expect(paletteCommandText("/", "model")).toBe("/model");
		// A stale row that the draft does not prefix degrades to the bare command.
		expect(paletteCommandText("/zzz", "model")).toBe("/model");
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

	test("parsePrewalkArgs arms the default, an explicit target, or restarts", () => {
		expect(parsePrewalkArgs("")).toEqual({ action: "arm" });
		expect(parsePrewalkArgs("  ")).toEqual({ action: "arm" });
		expect(parsePrewalkArgs("@smol")).toEqual({ action: "arm", target: "@smol" });
		expect(parsePrewalkArgs("openai/gpt-5")).toEqual({ action: "arm", target: "openai/gpt-5" });
		expect(parsePrewalkArgs("restart")).toEqual({ action: "restart" });
		expect(parsePrewalkArgs("  RESTART ")).toEqual({ action: "restart" });
	});

	test("parsePlanArgs toggles bare, forces off, or enables with a path", () => {
		expect(parsePlanArgs("")).toEqual({});
		expect(parsePlanArgs("off")).toEqual({ action: "disable" });
		expect(parsePlanArgs("  OFF ")).toEqual({ action: "disable" });
		expect(parsePlanArgs("plans/feature.md")).toEqual({ action: "enable", planFilePath: "plans/feature.md" });
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

describe("resumable session matching", () => {
	// Mirrors the TUI's `sessionMatchesResumeArg` fixtures: prefix matching on
	// the session id or file name, never a mid-string substring.
	const entry = (overrides: Partial<MachineSession>): MachineSession => ({
		path: "/home/me/.omp/sessions/proj/20260924T101500_9f2cabc123.jsonl",
		id: "9f2cabc123",
		cwd: "/home/me/proj",
		created: "2026-09-24T10:15:00Z",
		modified: "2026-09-24T11:00:00Z",
		messageCount: 4,
		firstMessage: "fix the flaky relay test",
		...overrides,
	});
	const listing = [
		entry({}),
		entry({ path: "/home/me/.omp/sessions/proj/20260923T090000_deadbeef.jsonl", id: "deadbeef" }),
	];

	test("matches a prefix of the session id", () => {
		expect(matchResumableSession(listing, "9f2c")).toEqual(listing[0]);
		expect(matchResumableSession(listing, "9F2CABC1")).toEqual(listing[0]);
		expect(matchResumableSession(listing, "deadbeef")).toEqual(listing[1]);
	});

	test("matches a prefix of the session file name, with or without the id segment", () => {
		expect(matchResumableSession(listing, "20260924")).toEqual(listing[0]);
		// The `.jsonl` suffix is stripped before matching, TUI `basename(file, ".jsonl")` parity.
		expect(matchResumableSession(listing, ".jsonl")).toBeUndefined();
		expect(matchResumableSession(listing, "dead")).toEqual(listing[1]);
	});

	test("does not match mid-string substrings", () => {
		expect(matchResumableSession(listing, "f2cab")).toBeUndefined();
		expect(matchResumableSession(listing, "proj")).toBeUndefined();
		expect(matchResumableSession(listing, "fix the flaky")).toBeUndefined();
	});

	test("empty queries and empty listings never match", () => {
		expect(matchResumableSession(listing, "")).toBeUndefined();
		expect(matchResumableSession(listing, "   ")).toBeUndefined();
		expect(matchResumableSession([], "9f2c")).toBeUndefined();
		expect(matchResumableSession(listing, "zzzz")).toBeUndefined();
	});

	test("first listing match wins (most recently modified first)", () => {
		const both = [entry({}), entry({ path: "/x/20260924T101500_9f2cabc123.jsonl", id: "zzzz" })];
		expect(matchResumableSession(both, "9f2c")).toEqual(both[0]);
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
		expect(trace.notices).toEqual([{ level: "warning", message: UNKNOWN_COMMAND_MESSAGE }]);
		// Inherited methods keep working through the wrapper: `Object.create(client)`
		// would drop the private-field brand and throw here.
		const probe = wrapped as unknown as FakeClient;
		expect(probe.sent()).toEqual(["explain the diff"]);
		expect(probe.sendAbort()).toBe("abort:1");
	});
});
