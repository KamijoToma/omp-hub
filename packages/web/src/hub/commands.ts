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
import type { LoopLimit } from "./api";

/**
 * Dialog a command opens; `SessionView` maps each kind to a component.
 * `"rewind"` opens from the slash table; `"context"` is the exception: the
 * header gauge opens it, no command does.
 */
export type ModalKind =
	| "model"
	| "thinking"
	| "rewind"
	| "todos"
	| "goal"
	| "loop"
	| "settings"
	| "links"
	| "help"
	| "context";

/** Local-only notice for a slash word that is not in the table. */
export const UNKNOWN_COMMAND_MESSAGE = "host-only or unknown command — not sent";

export interface CommandContext {
	openModal(kind: ModalKind): void;
	/** Flip the vendored theme store between light and dark. */
	toggleTheme(): void;
	navigate(path: string): void;
	/** Download the transcript snapshot as JSONL. */
	downloadDump(): void;
	notify(level: Notice["level"], message: string): void;
	/** POST the compact command; `SessionView` reports the outcome as a notice. */
	compactSession(request: CompactRequest): void;
	/** POST the retry command; `SessionView` reports the outcome as a notice. */
	retrySession(): void;
	/** POST the extended-context switch; `SessionView` reports the resulting state. */
	setExtendedContext(enabled?: boolean): void;
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

/** `/extended-context` argument polarity: `"on"` forces on, `"off"` forces off, anything else toggles. */
export function parseExtendedContextArg(args: string): boolean | undefined {
	const arg = args.trim().toLowerCase();
	if (arg === "on") return true;
	if (arg === "off") return false;
	return undefined;
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

/** §6 command table; also the palette order and the `/help` list. */
export const COMMANDS: readonly CommandSpec[] = [
	{ name: "model", description: "switch the session model", run: ctx => ctx.openModal("model") },
	{ name: "thinking", description: "set the thinking level", run: ctx => ctx.openModal("thinking") },
	{ name: "rewind", description: "rewind to an earlier message", run: ctx => ctx.openModal("rewind") },
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
	{ name: "retry", description: "retry the last failed turn", run: ctx => ctx.retrySession() },
	{ name: "todo", description: "show the session todo list", run: ctx => ctx.openModal("todos") },
	{ name: "goal", description: "session goal — set, pause, budget", run: ctx => ctx.openModal("goal") },
	{ name: "loop", description: "repeat a prompt on a loop", run: ctx => ctx.openModal("loop") },
	{
		name: "extended-context",
		description: "toggle extended context — [on|off]",
		run: (ctx, args) => ctx.setExtendedContext(parseExtendedContextArg(args)),
	},
	{
		name: "settings",
		description: "model, thinking, links, theme, display name",
		run: ctx => ctx.openModal("settings"),
	},
	{ name: "collab", description: "collab links — attach, view, web", run: ctx => ctx.openModal("links") },
	{ name: "theme", description: "toggle light / dark", run: ctx => ctx.toggleTheme() },
	{ name: "dump", description: "download the transcript as .jsonl", run: ctx => ctx.downloadDump() },
	{ name: "leave", description: "leave the session and return to the hub", run: ctx => ctx.navigate("/") },
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

export type ComposerRoute = "passthrough" | "ran" | "unknown" | "ignored";

/**
 * Resolve one composer submission. `"passthrough"` means the caller must send
 * the text to the agent; every other outcome consumed it locally.
 */
export function routeComposerText(text: string, ctx: CommandContext): ComposerRoute {
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
