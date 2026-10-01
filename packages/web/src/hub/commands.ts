/**
 * Web slash commands (docs/protocol.md §6).
 *
 * Text starting with `/` in the composer is NEVER sent to the agent: the
 * composer client wrapper ({@link createComposerClient}) hands it to
 * {@link routeComposerText}, which resolves it against {@link COMMANDS}. The
 * table is UI-free — commands act through {@link CommandContext} — so routing
 * stays unit-testable without React or a live session.
 */
import type { GuestClient, Notice } from "../lib/client";
import type { SessionEntry } from "../lib/wire";
import type { LoopLimit, MachineSession } from "./api";

/**
 * Dialog a command opens; `SessionView` maps each kind to a component.
 * `"rewind"` and `"tree"` open from the slash table; `"context"` is the
 * exception: the header gauge opens it, no command does. `args` seeds the
 * dialog (`/model sonnet:high` pre-fills the palette query; other kinds
 * ignore it).
 */
export type ModalKind =
	| "model"
	| "thinking"
	| "rewind"
	| "tree"
	| "resume"
	| "sessions"
	| "goal"
	| "loop"
	| "settings"
	| "links"
	| "help"
	| "context"
	| "mcp";

/** Local-only notice for a slash word that is not in the table. */
export const UNKNOWN_COMMAND_MESSAGE = "host-only or unknown command — not sent";

export interface CommandContext {
	openModal(kind: ModalKind, args?: string): void;
	/** Flip the vendored theme store between light and dark. */
	toggleTheme(): void;
	/** Leave the current session through the shared frame (including queued-message warning). */
	leaveSession(): void;
	/** Download the transcript snapshot as JSONL. */
	downloadDump(): void;
	notify(level: Notice["level"], message: string): void;
	/** POST the compact command; `SessionView` reports the outcome as a notice. */
	compactSession(request: CompactRequest): void;
	/** POST the shake command; `SessionView` reports the counts as a notice. */
	shakeSession(mode: string): void;
	/** POST the handoff command; `SessionView` reports the dispatch as a notice. */
	handoffSession(instructions?: string): void;
	/** POST the clear-context command; `SessionView` reports the dropped count as a notice. */
	clearContext(): void;
	/** Start a fresh session on the same machine and navigate to it; warns without a record. */
	startNewSession(): void;
	/** POST the rename command; `SessionView` reports the applied name as a notice. */
	renameSession(name: string): void;
	/** Generate a title from the conversation (bare `/rename`); `SessionView` reports the applied name. */
	generateTitle(): void;
	/**
	 * Resume another machine session (TUI `/resume`): a query resolves against
	 * the machine's resumable sessions and starts the first match; empty opens
	 * the picker. `SessionView` reports outcomes as notices.
	 */
	resumeSession(query: string): void;
	/** POST the retry command; `SessionView` reports the outcome as a notice. */
	retrySession(): void;
	/** POST the extended-context switch; `SessionView` reports the resulting state. */
	setExtendedContext(enabled?: boolean): void;
	/** POST the prewalk command; `SessionView` reports the armed state. */
	prewalkSession(request: PrewalkRequest): void;
	/** POST the plan command; bare requests toggle from the session's current state. */
	planSession(request: PlanRequest): void;
	/** POST the advisor toggle from the session's current state; `SessionView` reports it. */
	toggleAdvisor(): void;
	/** POST the tier set on the current model's family; `SessionView` reports the tier. */
	setTier(tier: string): void;
	/** POST the pause switch (server-side toggle); `SessionView` reports the state. */
	togglePause(): void;
	/** POST the model cycle (forward); `SessionView` reports the switched model. */
	cycleModel(): void;
	/** POST the role-model cycle (`cycleOrder`, 0.10.0+ agents); `SessionView` reports the switch. */
	cycleRoles(): void;
	/** Expand the docked todo panel above the composer. */
	showTodos(): void;
}

export interface CommandSpec {
	/** Slash word without the leading `/`; matched case-insensitively. */
	readonly name: string;
	readonly description: string;
	readonly run: (ctx: CommandContext, args: string) => void;
}

/** Parsed `/compact` arguments: an optional mode subcommand plus focus instructions. */
export interface CompactRequest {
	mode?: string;
	instructions?: string;
}

/**
 * Manual compact modes (oh-my-pi `session/compact-modes`). Only used to spot a
 * leading mode token: an unrecognized first word degrades to instructions, and
 * the agent re-validates whatever the hub forwards.
 */
const COMPACT_MODES: readonly string[] = ["soft", "remote", "snapcompact"];

/**
 * Split `/compact` args into a leading mode subcommand + focus instructions,
 * mirroring the agent's own parser: the first word is a mode only when it
 * names one; anything else is the whole instruction text. `snapcompact`
 * produces no LLM summary, so trailing instructions are a local error.
 */
export function parseCompactArgs(args: string): CompactRequest | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const stop = trimmed.search(/\s/);
	const first = (stop < 0 ? trimmed : trimmed.slice(0, stop)).toLowerCase();
	const rest = stop < 0 ? "" : trimmed.slice(stop + 1).trim();
	if (!COMPACT_MODES.includes(first)) return { instructions: trimmed };
	if (first === "snapcompact" && rest) return { error: "snapcompact takes no instructions" };
	return rest ? { mode: first, instructions: rest } : { mode: first };
}

/**
 * `/shake` modes (oh-my-pi `ShakeMode`). Only these three diets exist; the
 * agent re-validates whatever the hub forwards.
 */
const SHAKE_MODES: readonly string[] = ["elide", "images", "thinking"];

/**
 * Parse `/shake [elide|images|thinking]`: a bare call takes the default
 * `elide` diet (TUI `parseShakeMode` parity); anything beyond one mode word
 * is a local error — the caller shows it instead of sending the request.
 */
export function parseShakeArgs(args: string): string | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (SHAKE_MODES.includes(verb)) return verb;
	return { error: `Unknown /shake mode "${verb}". Use elide, images, or thinking.` };
}

/** `/extended-context` argument polarity: `"on"` forces on, `"off"` forces off, anything else toggles. */
export function parseExtendedContextArg(args: string): boolean | undefined {
	const arg = args.trim().toLowerCase();
	if (arg === "on") return true;
	if (arg === "off") return false;
	return undefined;
}

/** Parsed `/prewalk` arguments: arm (optionally with an explicit target) or restart. */
export interface PrewalkRequest {
	action: "arm" | "restart";
	/** Explicit model/role pattern; omitted arms the SDK default (`@smol`). */
	target?: string;
}

/**
 * Parse `/prewalk [target|restart]`: bare arms the default `@smol` role, a
 * recognized `restart` verb restores the pre-prewalk model and re-arms (TUI
 * parity), anything else is an explicit model/role pattern — the agent
 * re-validates whatever the hub forwards.
 */
export function parsePrewalkArgs(args: string): PrewalkRequest {
	const verb = args.trim();
	if (verb.toLowerCase() === "restart") return { action: "restart" };
	return verb ? { action: "arm", target: verb } : { action: "arm" };
}

/** Parsed `/plan` arguments: toggle (bare), force off, or enable with a plan file. */
export interface PlanRequest {
	action?: "enable" | "disable";
	planFilePath?: string;
}

/**
 * Parse `/plan [path|off]`: bare toggles (no action — the caller decides from
 * the session's current plan state), `off` forces disable, any other text
 * enables with that path as the plan file (SDK default reference path when
 * the caller drops it).
 */
export function parsePlanArgs(args: string): PlanRequest {
	const text = args.trim();
	if (!text) return {};
	if (text.toLowerCase() === "off") return { action: "disable" };
	return { action: "enable", planFilePath: text };
}

/** Loop duration units, in milliseconds (oh-my-pi `modes/loop-limit`). */
const LOOP_TIME_UNITS_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
};

/**
 * Parse a loop limit: `10` → 10 iterations; `10m` / `90s` / `1h30m` → a
 * duration in milliseconds. Null when the text is limit-shaped but invalid
 * (non-positive, unknown unit) — the caller shows a local error instead of
 * sending the request.
 */
export function parseLoopLimit(text: string): LoopLimit | null {
	const token = text.trim().toLowerCase();
	if (/^\d+$/.test(token)) {
		const iterations = Number(token);
		return Number.isSafeInteger(iterations) && iterations > 0 ? { kind: "iterations", iterations } : null;
	}
	if (!/^(?:\d+[a-z]+)+$/.test(token)) return null;
	let totalMs = 0;
	for (const segment of token.match(/\d+[a-z]+/g) ?? []) {
		const match = /^(\d+)([a-z]+)$/.exec(segment);
		const unitMs = match === null ? undefined : LOOP_TIME_UNITS_MS[match[2]];
		if (match === null || unitMs === undefined) return null;
		totalMs += Number(match[1]) * unitMs;
	}
	return totalMs > 0 ? { kind: "duration", durationMs: totalMs } : null;
}

/**
 * Resolve a `/resume <query>` argument against a machine's resumable sessions,
 * TUI parity with `resolveResumableSession`/`sessionMatchesResumeArg`
 * (oh-my-pi `session/session-listing`): case-insensitive prefix match on the
 * session id or the session file name, optionally just the id segment after
 * the last `_` of that name. First match in listing order (most recently
 * modified first) wins; empty queries never match.
 */
export function matchResumableSession(
	entries: readonly MachineSession[],
	query: string,
): MachineSession | undefined {
	const needle = query.trim().toLowerCase();
	if (!needle) return undefined;
	return entries.find(entry => {
		if (entry.id.toLowerCase().startsWith(needle)) return true;
		const base = (entry.path.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.jsonl$/, "");
		if (base.startsWith(needle)) return true;
		const separator = base.lastIndexOf("_");
		return separator >= 0 && base.slice(separator + 1).startsWith(needle);
	});
}

/** §6 command table; also the palette order and the `/help` list. */
export const COMMANDS: readonly CommandSpec[] = [
	{ name: "model", description: "switch the session model — [pattern] like sonnet:high", run: (ctx, args) => ctx.openModal("model", args.trim() || undefined) },
	{ name: "thinking", description: "set the thinking level", run: ctx => ctx.openModal("thinking") },
	{ name: "rewind", description: "rewind to an earlier message", run: ctx => ctx.openModal("rewind") },
	{
		name: "branch",
		description: "rewind, keeping the old path as a branch (TUI /branch)",
		run: ctx => ctx.openModal("rewind"),
	},
	{ name: "tree", description: "browse the session tree — switch branches", run: ctx => ctx.openModal("tree") },
	{
		name: "compact",
		description: "compact the context — [mode] [instructions]",
		run: (ctx, args) => {
			const parsed = parseCompactArgs(args);
			if ("error" in parsed) {
				ctx.notify("warning", parsed.error);
				return;
			}
			ctx.compactSession(parsed);
		},
	},
	{
		name: "shake",
		description: "drop heavy content — [elide|images|thinking]",
		run: (ctx, args) => {
			const mode = parseShakeArgs(args);
			if (typeof mode === "string") ctx.shakeSession(mode);
			else ctx.notify("warning", mode.error);
		},
	},
	{
		name: "handoff",
		description: "summarize into a handoff document and compact — [instructions]",
		run: (ctx, args) => ctx.handoffSession(args.trim() || undefined),
	},
	{ name: "clear", description: "clear the conversation context, keep the session", run: ctx => ctx.clearContext() },
	{ name: "new", description: "start a new session on this machine", run: ctx => ctx.startNewSession() },
	{
		name: "rename",
		description: "rename this session — [new name]; bare regenerates a title",
		run: (ctx, args) => {
			const name = args.trim();
			// Bare `/rename` regenerates a title from the conversation (TUI parity);
			// the sidebar's row dialog owns pointer-driven renames, the composer
			// takes the name inline.
			if (!name) {
				ctx.generateTitle();
				return;
			}
			ctx.renameSession(name);
		},
	},
	{
		name: "sessions",
		description: "switch between hub sessions — quick switcher (Ctrl+K)",
		run: ctx => ctx.openModal("sessions"),
	},
	{
		name: "resume",
		description: "resume another session on this machine — [session id]",
		run: (ctx, args) => ctx.resumeSession(args),
	},
	{ name: "retry", description: "retry the last failed turn", run: ctx => ctx.retrySession() },
	{ name: "todo", description: "show the agent's todo list", run: ctx => ctx.showTodos() },
	{ name: "goal", description: "session goal — set, pause, budget", run: ctx => ctx.openModal("goal") },
	{ name: "loop", description: "repeat a prompt on a loop", run: ctx => ctx.openModal("loop") },
	{
		name: "extended-context",
		description: "toggle extended context — [on|off]",
		run: (ctx, args) => ctx.setExtendedContext(parseExtendedContextArg(args)),
	},
	{
		name: "prewalk",
		description: "arm the one-shot prewalk hand-off — [target] or restart",
		run: (ctx, args) => ctx.prewalkSession(parsePrewalkArgs(args)),
	},
	{
		name: "plan",
		description: "toggle read-only plan mode — [path] sets the plan file",
		run: (ctx, args) => ctx.planSession(parsePlanArgs(args)),
	},
	{ name: "advisor", description: "toggle the second-model advisor", run: ctx => ctx.toggleAdvisor() },
	{ name: "fast", description: "priority service tier on the current model's family", run: ctx => ctx.setTier("priority") },
	{ name: "slow", description: "low-priority (flex) service tier on the current model's family", run: ctx => ctx.setTier("flex") },
	{ name: "pause", description: "freeze/resume the session's agent loop", run: ctx => ctx.togglePause() },
	{ name: "cycle", description: "cycle to the next model in the session's list", run: ctx => ctx.cycleModel() },
	{
		name: "cycle-roles",
		description: "cycle smol/default/slow role models (TUI ctrl+p parity)",
		run: ctx => ctx.cycleRoles(),
	},
	{
		name: "settings",
		description: "model, thinking, links, theme, display name, advanced settings",
		run: ctx => ctx.openModal("settings"),
	},
	{ name: "collab", description: "collab links — attach, view, web", run: ctx => ctx.openModal("links") },
	{ name: "mcp", description: "manage MCP servers — list, add, test, enable", run: ctx => ctx.openModal("mcp") },
	{ name: "theme", description: "toggle light / dark", run: ctx => ctx.toggleTheme() },
	{ name: "dump", description: "download the transcript as .jsonl", run: ctx => ctx.downloadDump() },
	{ name: "leave", description: "leave the session and open the New tab", run: ctx => ctx.leaveSession() },
	{ name: "help", description: "list the slash commands", run: ctx => ctx.openModal("help") },
];

export function findCommand(name: string): CommandSpec | undefined {
	const needle = name.toLowerCase();
	return COMMANDS.find(cmd => cmd.name === needle);
}

interface SlashWord {
	/** Lowercased command word; `""` for a bare `/`. */
	readonly name: string;
	readonly args: string;
}

/** Split leading-slash text into command word + args; null when `text` is not slash-led. */
function slashWord(text: string): SlashWord | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const rest = trimmed.slice(1);
	const stop = rest.search(/\s/);
	if (stop < 0) return { name: rest.toLowerCase(), args: "" };
	return { name: rest.slice(0, stop).toLowerCase(), args: rest.slice(stop + 1).trim() };
}

/** `/model openai/gpt-5` → `{ name: "model", args: "openai/gpt-5" }`; null for plain text and a bare `/`. */
export function parseCommand(text: string): SlashWord | null {
	const word = slashWord(text);
	return word && word.name ? word : null;
}

/**
 * Palette query: the command word typed so far (`/mo` → `"mo"`, `/model x` →
 * `"model"`, `/` → `""`), or null when the text is not a slash command.
 */
export function commandQuery(text: string): string | null {
	const word = slashWord(text);
	return word ? word.name : null;
}

/** Commands matching a palette query; every command for `""`, none for null. */
export function matchCommands(query: string | null): readonly CommandSpec[] {
	if (query === null) return [];
	if (query === "") return COMMANDS;
	return COMMANDS.filter(cmd => cmd.name.startsWith(query));
}

/**
 * Command text a palette activation (Enter/Tab/row click) should run for the
 * typed draft: typed args survive completion, so submitting on the `/rename`
 * row with `/rename my title` in the box runs `/rename my title`, while a
 * partial word completes (`/rena` → `/rename`). A draft whose word already
 * matches the row passes through untouched.
 */
export function paletteCommandText(text: string, name: string): string {
	const word = slashWord(text);
	if (!word || word.name === name) return text;
	if (word.name !== "" && !name.startsWith(word.name)) return `/${name}`;
	return `/${name}${word.args ? ` ${word.args}` : ""}`;
}

export type ComposerRoute = "passthrough" | "ran" | "unknown" | "ignored";

/**
 * Exact composer texts that mirror the TUI's continue shortcut (oh-my-pi
 * `input-controller`: submitting `.` or `c` resumes the agent). The collab
 * prompt path has no hidden continue directive, so the hub routes them to the
 * closest surface — `/retry` — instead of prompting the model with a literal
 * dot. Case-sensitive, matching the TUI.
 */
const RETRY_SHORTCUT_TEXTS: readonly string[] = [".", "c"];

/**
 * Resolve one composer submission. `"passthrough"` means the caller must send
 * the text to the agent; every other outcome consumed it locally.
 */
export function routeComposerText(text: string, ctx: CommandContext): ComposerRoute {
	// `.` / `c` mirror the TUI continue shortcut: consumed as a local retry,
	// never sent to the model verbatim.
	if (RETRY_SHORTCUT_TEXTS.includes(text.trim())) {
		ctx.retrySession();
		return "ran";
	}
	if (slashWord(text) === null) return "passthrough";
	const parsed = parseCommand(text);
	// A bare `/` is a draft in progress, not a command: neither sent nor noticed.
	if (!parsed) return "ignored";
	const spec = findCommand(parsed.name);
	if (!spec) {
		ctx.notify("warning", UNKNOWN_COMMAND_MESSAGE);
		return "unknown";
	}
	spec.run(ctx, parsed.args);
	return "ran";
}

/** One transcript entry per line, newline-terminated (JSONL). */
export function transcriptJsonl(entries: readonly SessionEntry[]): string {
	if (entries.length === 0) return "";
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

/** `<session>-<ts>.jsonl` with path-hostile characters folded to `-`. */
export function dumpFileName(sessionName: string, at: Date): string {
	const stem =
		sessionName
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^[.-]+|[.-]+$/g, "") || "session";
	return `${stem}-${at.toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

/**
 * Composer-facing wrapper around the vendored `GuestClient`: `sendPrompt` goes
 * to `intercept` (which returns true when the text was consumed locally, e.g. a
 * slash command), everything else stays the live client's.
 *
 * A `Proxy` is used rather than `Object.create(client)`: the inherited methods
 * touch `#private` fields, whose brand is checked against the receiver —
 * `Object.create` yields an object without those slots, so `sendAbort()` /
 * `sendUiResponse()` would throw "invalid private field". Reading through
 * `Reflect.get(target, prop, target)` keeps the receiver branded.
 */
export function createComposerClient(client: GuestClient, intercept: (text: string) => boolean): GuestClient {
	return new Proxy(client, {
		get(target, prop) {
			if (prop === "sendPrompt") {
				return (text: string): void => {
					if (!intercept(text)) target.sendPrompt(text);
				};
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
