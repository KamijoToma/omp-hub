/**
 * Wrapper daemon entry point (docs/architecture.md §2).
 *
 * Owns the hub socket, the session registry, and process lifecycle:
 * hub `start` → spawn a session child, child frames → hub reports, signals →
 * stop every child and exit.
 */

import { hostname } from "node:os";
import { HubClient } from "./hub-client";
import { createLogger, errorMessage } from "./log";
import { resolveMachineId } from "./machine-id";
import { Supervisor } from "./supervisor";

const DEFAULT_MAX_SESSIONS = 8;

const USAGE = [
	"Usage: bun src/main.ts --hub <url> [options]",
	"",
	"Options:",
	"  --hub <url>          hub base URL, e.g. ws://localhost:8787 (required)",
	"  --token <token>      hub shared token (default: $HUB_TOKEN)",
	"  --name <name>        agent display name (default: hostname)",
	"  --machine-id <id>    machine id (default: $AGENT_MACHINE_ID, else ~/.omp-hub-agent.json)",
	`  --max-sessions <n>   concurrent session cap (default: ${DEFAULT_MAX_SESSIONS})`,
	"  -h, --help           print this message",
].join("\n");

interface CliOptions {
	hub: string;
	token: string;
	name: string;
	machineId?: string;
	maxSessions: number;
}

/** Thrown for malformed argv; the caller prints usage and exits 1. */
class UsageError extends Error {}

const KNOWN_FLAGS: Record<string, true> = {
	"--hub": true,
	"--token": true,
	"--name": true,
	"--machine-id": true,
	"--max-sessions": true,
};

function parseArgs(argv: string[]): CliOptions | null {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "-h" || arg === "--help") return null;
		if (!arg.startsWith("--")) throw new UsageError(`unexpected argument: ${arg}`);

		const separator = arg.indexOf("=");
		const name = separator >= 0 ? arg.slice(0, separator) : arg;
		if (KNOWN_FLAGS[name] !== true) throw new UsageError(`unknown option: ${name}`);
		let value = separator >= 0 ? arg.slice(separator + 1) : undefined;
		if (value === undefined) {
			const next = argv[++index];
			if (next === undefined || next.startsWith("--")) throw new UsageError(`missing value for ${name}`);
			value = next;
		}
		values.set(name, value);
	}

	const hub = values.get("--hub")?.trim();
	if (!hub || (!hub.startsWith("ws://") && !hub.startsWith("wss://") && !hub.startsWith("http"))) {
		throw new UsageError("--hub <ws://host:port> is required");
	}

	const maxSessionsRaw = values.get("--max-sessions");
	let maxSessions = DEFAULT_MAX_SESSIONS;
	if (maxSessionsRaw !== undefined) {
		maxSessions = Number.parseInt(maxSessionsRaw, 10);
		if (!Number.isInteger(maxSessions) || maxSessions < 1) {
			throw new UsageError(`--max-sessions must be a positive integer, got: ${maxSessionsRaw}`);
		}
	}

	const name = values.get("--name")?.trim();
	return {
		hub,
		token: values.get("--token") ?? process.env.HUB_TOKEN ?? "",
		name: name && name.length > 0 ? name : hostname(),
		machineId: values.get("--machine-id"),
		maxSessions,
	};
}

async function main(): Promise<void> {
	let options: CliOptions | null;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`omp-hub agent: ${errorMessage(err)}\n\n${USAGE}\n`);
		process.exit(1);
		return;
	}
	if (options === null) {
		process.stderr.write(`${USAGE}\n`);
		return;
	}

	const log = createLogger();
	const machineId = await resolveMachineId(options.machineId);

	log.info(`hub url: ${options.hub}`);
	log.info(`name: ${options.name}`);
	log.info(`machine id: ${machineId}`);
	log.info(`max sessions: ${options.maxSessions}`);
	if (!options.token) log.warn("no --token/HUB_TOKEN set: connecting with an empty token (hub must run open)");

	const supervisor = new Supervisor(
		{
			onReady: (id, payload) =>
				client.send({
					t: "session-ready",
					id,
					sessionFile: payload.sessionFile,
					pid: payload.pid,
					links: payload.links,
				}),
			onError: (id, error) => client.send({ t: "session-error", id, error }),
			onExit: (id, code, reason) => client.send({ t: "session-exit", id, code, reason }),
		},
		log,
	);

	const client = new HubClient({
		url: options.hub,
		token: options.token,
		name: options.name,
		machineId,
		log,
		sessions: () => supervisor.status(),
		onWelcome: frame => log.info(`hub welcome: relay=${frame.relayUrl} web=${frame.webUrl}`),
		onStart: frame => {
			if (supervisor.liveCount >= options.maxSessions) {
				const error = `max sessions reached (${options.maxSessions})`;
				log.warn(`rejecting start for ${frame.id}: ${error}`);
				client.send({ t: "session-error", id: frame.id, error });
				return;
			}
			void supervisor
				.spawn({
					id: frame.id,
					cwd: frame.cwd,
					name: frame.name,
					prompt: frame.prompt,
					relayUrl: frame.relayUrl,
					webUrl: frame.webUrl,
				})
				.catch(err => client.send({ t: "session-error", id: frame.id, error: errorMessage(err) }));
		},
		onStop: frame => void supervisor.stop(frame.id, frame.reason ?? "hub stop"),
	});

	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`received ${signal}; shutting down`);
		void (async () => {
			try {
				await supervisor.stopAll("agent shutdown");
			} catch (err) {
				log.warn(`stopAll failed: ${errorMessage(err)}`);
			}
			client.close();
			process.exit(0);
		})();
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	client.start();
	log.info("agent daemon started");
}

void main().catch(err => {
	process.stderr.write(`omp-hub agent fatal: ${errorMessage(err)}\n`);
	process.exit(1);
});
