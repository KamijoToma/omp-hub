/**
 * Session host: one child process per session (docs/architecture.md §2).
 *
 * argv: `--config <json>` with { id, cwd, name?, prompt?, relayUrl, webUrl, agentDir? }.
 * stdout is a JSONL frame channel (docs/protocol.md §4) — `ready` | `error` — and
 * nothing else; every log line goes to stderr.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type * as ModelRoles from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type * as RoleModels from "@oh-my-pi/pi-coding-agent/session/role-models";
import type { parseConfiguredThinkingLevel as ParseThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { buildCollabCtx } from "./collab-ctx";
import { createLogger, errorMessage } from "./log";
import type { SessionLinks } from "./supervisor";

interface HostConfig {
	id: string;
	cwd: string;
	name?: string;
	prompt?: string;
	relayUrl: string;
	webUrl: string;
	agentDir?: string;
}

type ReadyFrame = { t: "ready"; sessionFile: string; pid: number; links: SessionLinks };

/** Parent → child `cmd` frame (protocol §4). */
type CommandFrame = {
	t: "cmd";
	reqId: string;
	cmd: string;
	provider?: string;
	modelId?: string;
	/** `set-model` target role; omitted means `"default"`. */
	role?: string;
	/** `set-model`: persist a non-default role assignment (default true). */
	persist?: boolean;
	level?: string;
};

/** Child → parent answer; exactly one per `cmd` (protocol §4). */
type CommandResultFrame =
	| { t: "cmd-result"; reqId: string; ok: true; data: unknown }
	| { t: "cmd-result"; reqId: string; ok: false; error: string };

/** One selectable model (protocol §2 AgentState). */
interface AgentModelRef {
	provider: string;
	id: string;
	name: string;
}

/** One chat-section model role and its current assignment (protocol §2). */
interface AgentRoleState {
	role: string;
	name: string;
	model: AgentModelRef | null;
}

/** `get-state` payload (protocol §2 AgentState). */
interface AgentState {
	sessionName: string;
	cwd: string;
	model: AgentModelRef | null;
	thinkingLevel: string | null;
	thinkingLevels: string[];
	models: AgentModelRef[];
	roles: AgentRoleState[];
}

/**
 * SDK functions the command surface needs, loaded lazily in `run()` after the
 * config boundary (with the rest of the SDK) so native-binding failures still
 * surface as JSONL error frames.
 */
interface CommandDeps {
	parseThinkingLevel: typeof ParseThinkingLevel;
	modelRoles: typeof ModelRoles;
	roleModels: typeof RoleModels;
}

/**
 * Levels offered when the current model declares no controllable effort surface
 * (`Model.thinking` unset — non-reasoning or router-selected models).
 */
const FALLBACK_THINKING_LEVELS: readonly string[] = ["off", "low", "medium", "high"];

/** `get-state`: session identity plus the model/thinking surface for the web UI. */
function agentState(session: AgentSession, deps: CommandDeps): AgentState {
	const model = session.model;
	const efforts = session.getAvailableThinkingLevels();
	const available = session.getAvailableModels();
	return {
		sessionName: session.sessionName ?? "",
		cwd: session.sessionManager.getCwd(),
		model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null,
		thinkingLevel: session.thinkingLevel ?? null,
		// `off` is always selectable; the rest are the model's declared efforts
		// (`Model.thinking.efforts`, already filtered to the reasoning-capable set).
		thinkingLevels: efforts.length > 0 ? ["off", ...efforts] : [...FALLBACK_THINKING_LEVELS],
		models: available.map(entry => ({
			provider: entry.provider,
			id: entry.id,
			name: entry.name ?? entry.id,
		})),
		roles: agentRoles(session, available, deps),
	};
}

/**
 * Chat-section roles with their resolved assignment. Kind roles (image/web/
 * speech/…) select non-chat models the web picker never lists, so they stay
 * host-only. The default role resolves to the active model when unconfigured.
 */
function agentRoles(session: AgentSession, available: Model[], deps: CommandDeps): AgentRoleState[] {
	const roles: AgentRoleState[] = [];
	for (const role of deps.modelRoles.getKnownRoleIds(session.settings)) {
		const info = deps.modelRoles.getRoleInfo(role, session.settings);
		if (info.section !== "chat") continue;
		const resolved = deps.roleModels.resolveRoleModelFull(session.settings, role, available, session.model ?? undefined);
		roles.push({
			role,
			name: info.name || role,
			model: resolved.model
				? { provider: resolved.model.provider, id: resolved.model.id, name: resolved.model.name ?? resolved.model.id }
				: null,
		});
	}
	return roles;
}

/** Validated `set-model` role; omitted/blank means `"default"`. */
function parseRole(role: string | undefined): string {
	if (role === undefined) return "default";
	const trimmed = role.trim();
	if (trimmed === "" || trimmed.length > 64) throw new Error(`invalid model role: ${JSON.stringify(role)}`);
	return trimmed;
}

/** Run one session command; a throw becomes `{ok:false,error}` on the wire (§4). */
async function executeCommand(session: AgentSession, frame: CommandFrame, deps: CommandDeps): Promise<unknown> {
	switch (frame.cmd) {
		case "get-state":
			return agentState(session, deps);
		case "set-model": {
			const { provider, modelId } = frame;
			if (!provider || !modelId) throw new Error("set-model requires provider and modelId");
			const role = parseRole(frame.role);
			const model = session.modelRegistry.find(provider, modelId);
			if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
			// A non-default role is a persistent assignment (omp `/model @role`):
			// it switches the active model now AND survives the session unless
			// `persist: false`. The plain switch keeps its session-scope behavior.
			const { switched } = await session.setModel(
				model,
				role,
				role === "default" || frame.persist === false ? undefined : { persist: true },
			);
			return { switched, role };
		}
		case "set-thinking": {
			const level = deps.parseThinkingLevel(frame.level);
			if (level === undefined) throw new Error(`invalid thinking level: ${String(frame.level)}`);
			session.setThinkingLevel(level);
			return { thinkingLevel: session.thinkingLevel ?? null };
		}
		default:
			throw new Error(`unknown command: ${String(frame.cmd)}`);
	}
}

const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

// stdout carries frames and nothing else (§4). Any stray write from the SDK, an
// extension, or a dependency is rerouted to stderr so the supervisor's JSONL
// parser never sees foreign bytes.
process.stdout.write = ((...args: Parameters<typeof rawStdoutWrite>) =>
	stderrWrite(...args)) as typeof process.stdout.write;

// Bun's console writes to fd 1 without going through process.stdout.write, so the
// stdout-bound console methods need the same treatment.
for (const method of ["log", "info", "debug"] as const) {
	console[method] = (...data: unknown[]) => console.error(...data);
}

const REQUIRED_CONFIG_KEYS = ["id", "cwd", "relayUrl"] as const;

function parseConfig(argv: string[]): HostConfig {
	let raw: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--config") raw = argv[++index];
		else if (arg.startsWith("--config=")) raw = arg.slice("--config=".length);
		else throw new Error(`unexpected argument: ${arg}`);
	}
	if (!raw) throw new Error("missing required --config <json>");

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`invalid --config JSON: ${errorMessage(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("--config must be a JSON object");

	const config = parsed as Record<string, unknown>;
	for (const key of REQUIRED_CONFIG_KEYS) {
		const value = config[key];
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`--config.${key} must be a non-empty string`);
		}
	}
	const optional = (key: string): string | undefined => {
		const value = config[key];
		return typeof value === "string" && value.trim() ? value : undefined;
	};

	return {
		id: config.id as string,
		cwd: config.cwd as string,
		name: optional("name"),
		prompt: optional("prompt"),
		relayUrl: config.relayUrl as string,
		webUrl: typeof config.webUrl === "string" ? config.webUrl : "",
		agentDir: optional("agentDir"),
	};
}

async function run(): Promise<void> {
	const config = parseConfig(process.argv.slice(2));
	const log = createLogger(`session ${config.id}`);

	// Stop intents are recorded from the first moment: a supervisor `stop` (or
	// stdin EOF) can land while the session is still booting, and the frame must
	// not be dropped just because CollabHost does not exist yet. `shutdownRequest`
	// is wired once the session is up; until then the reason is parked.
	let stopRequested: string | undefined;
	let shutdownRequest: ((reason: string) => void) | undefined;
	const requestStop = (reason: string): void => {
		if (shutdownRequest) shutdownRequest(reason);
		else stopRequested ??= reason;
	};

	const decoder = new TextDecoder();
	let stdinBuffer = "";
	// Commands are answered only once the session exists (`ready`); earlier frames
	// get a plain `{ok:false}` rather than silence — the parent waits on exactly
	// one `cmd-result` per request.
	let commandRunner: ((frame: CommandFrame) => Promise<void>) | undefined;
	const respond = (frame: CommandResultFrame): void => {
		rawStdoutWrite(`${JSON.stringify(frame)}\n`);
	};
	const handleStdinLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			log.warn(`ignoring non-JSON stdin line: ${line}`);
			return;
		}
		const frame = (parsed ?? {}) as Partial<CommandFrame> | { t: "stop"; reason?: unknown };
		switch (frame.t) {
			case "stop":
				requestStop(typeof frame.reason === "string" ? frame.reason : "stop");
				return;
			case "cmd": {
				const request: CommandFrame = {
					t: "cmd",
					reqId: typeof frame.reqId === "string" ? frame.reqId : "",
					cmd: typeof frame.cmd === "string" ? frame.cmd : "",
					provider: typeof frame.provider === "string" ? frame.provider : undefined,
					modelId: typeof frame.modelId === "string" ? frame.modelId : undefined,
					role: typeof frame.role === "string" ? frame.role : undefined,
					persist: typeof frame.persist === "boolean" ? frame.persist : undefined,
					level: typeof frame.level === "string" ? frame.level : undefined,
				};
				if (!commandRunner) {
					respond({ t: "cmd-result", reqId: request.reqId, ok: false, error: "session is not ready" });
					return;
				}
				void commandRunner(request);
				return;
			}
			default:
				log.debug(`ignoring unknown stdin frame: ${line}`);
		}
	};
	process.stdin.on("data", (chunk: Uint8Array | string) => {
		stdinBuffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let newline = stdinBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = stdinBuffer.slice(0, newline).trim();
			stdinBuffer = stdinBuffer.slice(newline + 1);
			if (line) handleStdinLine(line);
			newline = stdinBuffer.indexOf("\n");
		}
	});
	// stdin EOF means the supervisor is gone; never linger as an orphan.
	process.stdin.on("end", () => requestStop("stdin closed"));
	process.on("SIGTERM", () => requestStop("sigterm"));
	process.on("SIGINT", () => requestStop("sigint"));

	const cwd = await stat(config.cwd).catch(() => null);
	if (!cwd?.isDirectory()) throw new Error(`cwd is not an existing directory: ${config.cwd}`);

	// Static SDK imports run before stdout sealing and this catch boundary;
	// load them here so native-binding failures still reach the supervisor as
	// JSONL. Same for the role-model helpers: they transitively pull the SDK
	// tree, which cannot load before this boundary in a broken-native install.
	const { createAgentSession, initTheme, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
	const { CollabHost } = await import("@oh-my-pi/pi-coding-agent/collab/host");
	const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
	const { parseConfiguredThinkingLevel } = await import("@oh-my-pi/pi-tui/thinking");
	const modelRoles = await import("@oh-my-pi/pi-coding-agent/config/model-roles");
	const roleModels = await import("@oh-my-pi/pi-coding-agent/session/role-models");
	const { createStubUIContext } = await import("./ui-stub");
	const commandDeps: CommandDeps = { parseThinkingLevel: parseConfiguredThinkingLevel, modelRoles, roleModels };

	// loadIsolated, never the Settings.init() singleton: one process hosts exactly
	// one session, and the global would freeze the first cwd.
	const settings = await Settings.loadIsolated({ cwd: config.cwd, agentDir: config.agentDir });
	const displayName = config.name?.trim() || basename(config.cwd);
	settings.override("collab.displayName", displayName);

	const sessionManager = SessionManager.create(config.cwd);
	const { session, eventBus, setToolUIContext } = await createAgentSession({
		cwd: config.cwd,
		agentDir: config.agentDir,
		settings,
		sessionManager,
		agentId: `hub-${config.id}`,
		agentDisplayName: displayName,
		hasUI: false,
		autoApprove: true,
	});

	await initTheme().catch(err => log.warn(`theme init failed: ${errorMessage(err)}`));
	const ui = createStubUIContext();
	setToolUIContext(ui, false);
	await initializeExtensions(session, {
		uiContext: ui,
		reportSendError: () => {},
		reportRuntimeError: () => {},
	});

	const ctx = buildCollabCtx(session, eventBus);
	const host = new CollabHost(ctx);
	await host.start(config.relayUrl, config.webUrl);
	ctx.collabHost = host;

	const sessionFile = session.sessionManager.getSessionFile() ?? "";
	const ready: ReadyFrame = {
		t: "ready",
		sessionFile,
		pid: process.pid,
		links: { full: host.link, view: host.viewLink, web: host.webLink, webView: host.webViewLink },
	};
	rawStdoutWrite(`${JSON.stringify(ready)}\n`);
	log.info(`ready: session ${session.sessionManager.getSessionId()} pid ${process.pid} file ${sessionFile}`);
	// Commands are served from `ready` on; exactly one `cmd-result` per request (§4).
	commandRunner = runCommand;

	let stopping = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		log.info(`stopping (${reason})`);
		// The supervisor SIGKILLs 10 s after stop; never leave it to that.
		const bail = setTimeout(() => {
			log.warn("dispose did not finish in 9s; forcing exit");
			process.exit(0);
		}, 9_000);
		bail.unref();
		try {
			await host.stop(reason);
		} catch (err) {
			log.warn(`collab stop failed: ${errorMessage(err)}`);
		}
		try {
			session.beginDispose();
			await session.dispose();
		} catch (err) {
			log.warn(`session dispose failed: ${errorMessage(err)}`);
		}
		clearTimeout(bail);
		process.exit(0);
	};

	shutdownRequest = reason => void shutdown(reason);
	if (stopRequested !== undefined) shutdownRequest(stopRequested);

	if (config.prompt) {
		void session.prompt(config.prompt).catch(err => log.error(`initial prompt failed: ${errorMessage(err)}`));
	}

	/** Answer one `cmd` frame: success data, or the thrown message as `error` (§4). */
	async function runCommand(frame: CommandFrame): Promise<void> {
		if (stopping) {
			respond({ t: "cmd-result", reqId: frame.reqId, ok: false, error: "session is stopping" });
			return;
		}
		try {
			const data = await executeCommand(session, frame, commandDeps);
			respond({ t: "cmd-result", reqId: frame.reqId, ok: true, data });
		} catch (err) {
			log.warn(`command ${frame.cmd} failed: ${errorMessage(err)}`);
			respond({ t: "cmd-result", reqId: frame.reqId, ok: false, error: errorMessage(err) });
		}
	}
}

run().catch(async err => {
	const message = errorMessage(err);
	rawStdoutWrite(`${JSON.stringify({ t: "error", message })}\n`);
	process.stderr.write(`session-host fatal: ${message}\n`);
	// Give the pipe reader a beat to see the frame before the hard exit.
	const grace = Promise.withResolvers<void>();
	setTimeout(grace.resolve, 20);
	await grace.promise;
	process.exit(1);
});
