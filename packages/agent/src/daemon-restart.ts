/**
 * Daemon upgrade restart (docs/protocol.md §2 `restart-daemon`): stop every
 * session child gracefully so the SDK flushes its transcript, then self-spawn
 * a fresh daemon from disk — same entry point, same argv — so a panel restart
 * picks up new agent code without any shell access on the machine. Mirrors the
 * hub's own upgrade-restart handover (`packages/hub/src/server.ts`), minus the
 * port race: the daemon is outbound-only, so the fresh process simply
 * reconnects. The hub recognizes the restart and re-issues same-id starts.
 */

import type { Logger } from "./log";
import { errorMessage } from "./log";
import { isCompiledAgent } from "./native-mode";
import type { Supervisor } from "./supervisor";

export interface DaemonRestartOptions {
	/** Stop-and-flip surface of the supervisor the test seam can stub. */
	supervisor: Pick<Supervisor, "stopAll">;
	log: Logger;
	/** Stops the per-profile usage dashboards (same shutdown path as SIGTERM). */
	stopDashboards: () => void;
	/** Injectable for tests; defaults to a detached Bun spawn. */
	spawnReplacement?: (argv: string[]) => unknown;
	/** Injectable for tests; defaults to `process.exit`. */
	exit?: (code: number) => void;
}

/** Default replacement spawn: stdio inherits the daemon's own stdout/stderr, so
 * production logs keep flowing into whatever stream the operator launched with
 * (e.g. the `daemon.log` shell redirect) with no reconfiguration. */
function spawnReplacement(argv: string[]): unknown {
	return Bun.spawn(argv, { stdio: ["ignore", "inherit", "inherit"] });
}

/** A compiled daemon is the executable itself; its virtual `$bunfs` argv[1] is not an entry argument. */
export function restartSpawnArgv(argv: readonly string[] = process.argv, compiled = isCompiledAgent): string[] {
	const userArgs = argv.slice(compiled ? 2 : 1);
	return [process.execPath, ...userArgs];
}

/**
 * The restart sequence. Order matters: children must be fully stopped (their
 * session files released, transcripts flushed) BEFORE the replacement spawns,
 * because the hub replays same-id resumes as soon as the fresh daemon
 * reconnects, and a still-live old child would trip the daemon's
 * session-file-in-use guard.
 */
export async function performDaemonRestart(options: DaemonRestartOptions): Promise<void> {
	const { supervisor, log, stopDashboards } = options;
	log.info("daemon restart requested — stopping sessions and handing off to a fresh process");
	await supervisor.stopAll("daemon upgrade");
	stopDashboards();
	const spawn = options.spawnReplacement ?? spawnReplacement;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	spawn(restartSpawnArgv());
	// Give the fork a beat to register with the OS before this process vanishes;
	// an orphaned-but-unexeced child would leave the machine daemonless.
	await Bun.sleep(100);
	exit(0);
}

/** Formatted failure text for the restart path (logged, never thrown past the caller). */
export function restartFailure(err: unknown): string {
	return `daemon restart failed: ${errorMessage(err)}`;
}
