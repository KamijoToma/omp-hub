/**
 * Minimal stderr logger.
 *
 * The hub is a long-running service: its stdout stays clean (child processes of the
 * wrapper are JSONL-parsed, and operators pipe logs), so every hub log line goes to stderr.
 */
type Level = "info" | "warn" | "error";

function write(level: Level, message: string): void {
	process.stderr.write(`[hub] ${level}: ${message}\n`);
}

export const log = {
	info: (message: string): void => write("info", message),
	warn: (message: string): void => write("warn", message),
	error: (message: string): void => write("error", message),
};
