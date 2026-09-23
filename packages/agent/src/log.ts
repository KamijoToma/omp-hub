/**
 * Tiny stderr logger for the wrapper daemon.
 *
 * stdout is owned by the supervisor JSONL protocol (docs/protocol.md §4), so
 * every log line — in the daemon and in every session child — goes to stderr.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_NAMES: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const configuredLevel = (process.env.OMP_HUB_AGENT_LOG ?? "").trim().toLowerCase();

let threshold = LEVELS[LEVEL_NAMES.find(name => name === configuredLevel) ?? "info"];

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** Render an unknown thrown value as a single log-safe line. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Create a logger whose lines are prefixed with `[prefix]` (session ids, roles). */
export function createLogger(prefix?: string): Logger {
	const scope = prefix ? `[${prefix}] ` : "";
	const emit = (level: LogLevel, message: string): void => {
		if (LEVELS[level] < threshold) return;
		process.stderr.write(`${new Date().toISOString()} ${level.padEnd(5)} ${scope}${message}\n`);
	};
	return {
		debug: message => emit("debug", message),
		info: message => emit("info", message),
		warn: message => emit("warn", message),
		error: message => emit("error", message),
	};
}
