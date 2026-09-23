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

/** Dialog a command opens; `SessionView` maps each kind to a component. */
export type ModalKind = "model" | "thinking" | "settings" | "links" | "help";

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
}

export interface CommandSpec {
	/** Slash word without the leading `/`; matched case-insensitively. */
	readonly name: string;
	readonly description: string;
	readonly run: (ctx: CommandContext, args: string) => void;
}

/** §6 command table; also the palette order and the `/help` list. */
export const COMMANDS: readonly CommandSpec[] = [
	{ name: "model", description: "switch the session model", run: ctx => ctx.openModal("model") },
	{ name: "thinking", description: "set the thinking level", run: ctx => ctx.openModal("thinking") },
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
