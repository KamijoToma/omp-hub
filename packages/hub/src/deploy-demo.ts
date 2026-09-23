import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_HUB_SERVICE = "demohub";
const DEFAULT_AGENT_SERVICE = "demoagent";
const DEFAULT_TIMEOUT_MS = 60_000;
const STATE_VERSION = 1;

const USAGE = `Usage: bun packages/hub/src/deploy-demo.ts [options]

Incrementally deploy the checked-out commit to the local demo managed by omp ps.

Options:
  --from <commit>          deployed commit for the first run (required without state)
  --record-current        record HEAD as already deployed; perform no build or restart
  --dry-run               print the plan without changing files or processes
  --rollback-web          atomically restore the previously deployed Web release
  --force-active          allow disruptive restarts while sessions are starting/live
  --hub-service <name>    omp ps hub service (default: ${DEFAULT_HUB_SERVICE})
  --agent-service <name>  omp ps agent service (default: ${DEFAULT_AGENT_SERVICE})
  --service-dir <path>    omp ps project scope (default: repository root)
  --hub-url <url>         local hub URL (default: derived from the hub service)
  --deploy-root <path>    release storage (default: Git common dir/omp-hub-demo)
  --state-file <path>     deployment state (default: Git common dir/omp-hub-demo/state.json)
  --timeout <seconds>     readiness deadline (default: ${DEFAULT_TIMEOUT_MS / 1000})
  -h, --help              print this help

HUB_TOKEN overrides the token read privately from the supervised hub specification.`;

export interface DeployComponents {
	web: boolean;
	hub: boolean;
	agent: boolean;
}

export interface SessionSummary {
	id: string;
	name: string;
	status: string;
}

interface DeployState {
	version: typeof STATE_VERSION;
	components: {
		web: string;
		hub: string;
		agent: string;
	};
	webRelease?: string;
	previousWebRelease?: string;
	updatedAt: string;
}

interface CliOptions {
	from?: string;
	recordCurrent: boolean;
	rollbackWeb: boolean;
	dryRun: boolean;
	forceActive: boolean;
	hubService: string;
	agentService: string;
	serviceDir?: string;
	hubUrl?: string;
	stateFile?: string;
	deployRoot?: string;
	timeoutMs: number;
	help: boolean;
}

interface OmpServiceInfo {
	state?: string;
	spec?: {
		cwd?: string;
		env?: Record<string, string>;
	};
}

interface MachineRecord {
	machineId: string;
	connected: boolean;
}

interface RuntimeAccess {
	hubUrl: string;
	token: string;
	connectedMachineIds: string[];
}

interface WebBuild {
	releasePath: string;
}

export type PreviousWebDist =
	| { kind: "missing" }
	| { kind: "symlink"; target: string }
	| { kind: "directory"; backupPath: string };

export interface WebDistSwitch {
	distPath: string;
	previous: PreviousWebDist;
}

export interface CoordinatedRestartOps {
	restartAgent(): Promise<void>;
	restartHub(): Promise<void>;
	waitForHub(): Promise<void>;
	waitForAgent(): Promise<void>;
}

function isNeutralPath(file: string): boolean {
	return (
		file === "AGENTS.md" ||
		file === "LICENSE" ||
		file === ".gitignore" ||
		file === ".dockerignore" ||
		file === "README.md" ||
		file === "README.zh-CN.md" ||
		file.startsWith("docs/") ||
		file.startsWith("docker/") ||
		file.startsWith(".github/") ||
		file.startsWith("scripts/") ||
		/^packages\/(?:web|hub|agent)\/test\//.test(file) ||
		file === "packages/agent/README.md" ||
		file === "packages/hub/src/deploy-demo.ts"
	);
}

/** Maps tracked paths to the long-running components whose loaded code/assets change. */
export function classifyChangedPaths(files: readonly string[]): DeployComponents {
	const result: DeployComponents = { web: false, hub: false, agent: false };
	for (const file of files) {
		if (isNeutralPath(file)) continue;
		if (file.startsWith("packages/web/")) {
			result.web = true;
			continue;
		}
		if (file.startsWith("packages/hub/")) {
			result.hub = true;
			continue;
		}
		if (file.startsWith("packages/agent/")) {
			result.agent = true;
			continue;
		}
		// A future shared runtime path is safer to deploy everywhere than silently skip.
		result.web = true;
		result.hub = true;
		result.agent = true;
	}
	return result;
}

/** Returns every non-terminal session and rejects malformed API payloads. */
export function findActiveSessions(value: unknown): SessionSummary[] {
	if (value === null || typeof value !== "object" || !("sessions" in value) || !Array.isArray(value.sessions)) {
		throw new Error("/api/sessions returned a malformed response");
	}
	const active: SessionSummary[] = [];
	for (const item of value.sessions) {
		if (
			item === null ||
			typeof item !== "object" ||
			!("id" in item) ||
			typeof item.id !== "string" ||
			!("name" in item) ||
			typeof item.name !== "string" ||
			!("status" in item) ||
			typeof item.status !== "string"
		) {
			throw new Error("/api/sessions returned a malformed session");
		}
		if (item.status === "exited" || item.status === "failed") continue;
		active.push({ id: item.id, name: item.name, status: item.status });
	}
	return active;
}

function errorCode(error: unknown): string | undefined {
	if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}

async function pathKind(target: string): Promise<"missing" | "symlink" | "directory" | "other"> {
	try {
		const stat = await lstat(target);
		if (stat.isSymbolicLink()) return "symlink";
		if (stat.isDirectory()) return "directory";
		return "other";
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing";
		throw error;
	}
}

/** Switches the stable `dist` path to a completed release; symlink-to-symlink is atomic. */
export async function switchWebDist(distPath: string, releasePath: string, backupRoot: string): Promise<WebDistSwitch> {
	if ((await pathKind(releasePath)) !== "directory") throw new Error(`web release is not a directory: ${releasePath}`);
	await mkdir(path.dirname(distPath), { recursive: true });
	await mkdir(backupRoot, { recursive: true });

	const temporaryLink = `${distPath}.next-${process.pid}-${crypto.randomUUID()}`;
	const relativeTarget = path.relative(path.dirname(distPath), releasePath) || ".";
	await symlink(relativeTarget, temporaryLink, "dir");

	const kind = await pathKind(distPath);
	try {
		if (kind === "symlink") {
			const target = await readlink(distPath);
			await rename(temporaryLink, distPath);
			return { distPath, previous: { kind: "symlink", target } };
		}
		if (kind === "directory") {
			const backupPath = path.join(backupRoot, `legacy-dist-${Date.now()}-${crypto.randomUUID()}`);
			await rename(distPath, backupPath);
			try {
				await rename(temporaryLink, distPath);
			} catch (error) {
				await rename(backupPath, distPath);
				throw error;
			}
			return { distPath, previous: { kind: "directory", backupPath } };
		}
		if (kind === "missing") {
			await rename(temporaryLink, distPath);
			return { distPath, previous: { kind: "missing" } };
		}
		throw new Error(`refusing to replace non-directory web dist: ${distPath}`);
	} finally {
		await rm(temporaryLink, { force: true });
	}
}

/** Restores the exact path captured by {@link switchWebDist}. */
export async function rollbackWebDist(change: WebDistSwitch): Promise<void> {
	const { distPath, previous } = change;
	if (previous.kind === "directory") {
		await rm(distPath, { force: true, recursive: true });
		await rename(previous.backupPath, distPath);
		return;
	}
	if (previous.kind === "missing") {
		await rm(distPath, { force: true, recursive: true });
		return;
	}
	const temporaryLink = `${distPath}.rollback-${process.pid}-${crypto.randomUUID()}`;
	await symlink(previous.target, temporaryLink, "dir");
	try {
		await rename(temporaryLink, distPath);
	} finally {
		await rm(temporaryLink, { force: true });
	}
}

function parseOptions(argv: string[]): CliOptions {
	const options: CliOptions = {
		recordCurrent: false,
		rollbackWeb: false,
		dryRun: false,
		forceActive: false,
		hubService: DEFAULT_HUB_SERVICE,
		agentService: DEFAULT_AGENT_SERVICE,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		help: false,
	};
	const value = (index: number, flag: string): string => {
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
		return next;
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "--record-current") options.recordCurrent = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--force-active") options.forceActive = true;
		else if (arg === "--rollback-web") options.rollbackWeb = true;
		else if (arg === "--from") options.from = value(index++, arg);
		else if (arg === "--hub-service") options.hubService = value(index++, arg);
		else if (arg === "--agent-service") options.agentService = value(index++, arg);
		else if (arg === "--service-dir") options.serviceDir = value(index++, arg);
		else if (arg === "--hub-url") options.hubUrl = value(index++, arg);
		else if (arg === "--state-file") options.stateFile = value(index++, arg);
		else if (arg === "--deploy-root") options.deployRoot = value(index++, arg);
		else if (arg === "--timeout") {
			const seconds = Number(value(index++, arg));
			if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number of seconds");
			options.timeoutMs = Math.round(seconds * 1000);
		} else throw new Error(`unknown option: ${arg}`);
	}
	const exclusiveModes = Number(options.recordCurrent) + Number(options.rollbackWeb);
	if (exclusiveModes > 1 || (exclusiveModes > 0 && (options.from !== undefined || options.dryRun))) {
		throw new Error("--record-current and --rollback-web cannot be combined with --from, --dry-run, or each other");
	}
	return options;
}

async function captureCommand(command: string[], cwd: string): Promise<string> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		const detail = stderr.trim();
		throw new Error(`${command[0]} ${command.slice(1).join(" ")} exited ${exitCode}${detail ? `: ${detail}` : ""}`);
	}
	return stdout.trim();
}

async function runCommand(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit", env: process.env });
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command[0]} ${command.slice(1).join(" ")} exited ${exitCode}`);
}

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	return captureCommand(["git", ...args], repoRoot);
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
	return git(repoRoot, "rev-parse", "--verify", `${ref}^{commit}`);
}

async function changedPaths(repoRoot: string, from: string, to: string): Promise<string[]> {
	const output = await git(repoRoot, "diff", "--name-only", "--diff-filter=ACMRD", `${from}..${to}`);
	return output ? output.split("\n").filter(Boolean) : [];
}

async function assertDeployableWorktree(repoRoot: string): Promise<void> {
	const tracked = await git(repoRoot, "status", "--porcelain", "--untracked-files=no");
	if (tracked) throw new Error(`tracked worktree changes would contaminate deployment:\n${tracked}`);
	const packageChanges = await git(
		repoRoot,
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		"packages/web",
		"packages/hub",
		"packages/agent",
	);
	if (packageChanges) throw new Error(`untracked package files would contaminate deployment:\n${packageChanges}`);
}

function initialState(commit: string): DeployState {
	return {
		version: STATE_VERSION,
		components: { web: commit, hub: commit, agent: commit },
		updatedAt: new Date().toISOString(),
	};
}

async function readState(stateFile: string): Promise<DeployState | null> {
	let raw: string;
	try {
		raw = await readFile(stateFile, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!("version" in parsed) ||
		parsed.version !== STATE_VERSION ||
		!("components" in parsed) ||
		parsed.components === null ||
		typeof parsed.components !== "object" ||
		!("web" in parsed.components) ||
		typeof parsed.components.web !== "string" ||
		!("hub" in parsed.components) ||
		typeof parsed.components.hub !== "string" ||
		!("agent" in parsed.components) ||
		typeof parsed.components.agent !== "string" ||
		!("updatedAt" in parsed) ||
		typeof parsed.updatedAt !== "string"
	) {
		throw new Error(`unsupported or malformed deployment state: ${stateFile}`);
	}
	return {
		version: STATE_VERSION,
		components: {
			web: parsed.components.web,
			hub: parsed.components.hub,
			agent: parsed.components.agent,
		},
		...("webRelease" in parsed && typeof parsed.webRelease === "string" ? { webRelease: parsed.webRelease } : {}),
		...("previousWebRelease" in parsed && typeof parsed.previousWebRelease === "string"
			? { previousWebRelease: parsed.previousWebRelease }
			: {}),
		updatedAt: parsed.updatedAt,
	};
}

async function writeState(stateFile: string, state: DeployState): Promise<void> {
	await mkdir(path.dirname(stateFile), { recursive: true });
	const temporary = `${stateFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, stateFile);
}

async function readServiceInfo(name: string, serviceDir: string): Promise<OmpServiceInfo> {
	const output = await captureCommand(["omp", "ps", "info", name, `--dir=${serviceDir}`, "--json"], serviceDir);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		// The JSON can contain credentials in its service environment; never echo it in an error.
		throw new Error(`omp ps returned invalid JSON for service ${name}`);
	}
	if (parsed === null || typeof parsed !== "object") throw new Error(`omp ps returned invalid data for service ${name}`);
	const state = "state" in parsed && typeof parsed.state === "string" ? parsed.state : undefined;
	if (!("spec" in parsed) || parsed.spec === null || typeof parsed.spec !== "object") return { state };
	const cwd = "cwd" in parsed.spec && typeof parsed.spec.cwd === "string" ? parsed.spec.cwd : undefined;
	let env: Record<string, string> | undefined;
	if ("env" in parsed.spec && parsed.spec.env !== null && typeof parsed.spec.env === "object") {
		env = {};
		for (const [key, value] of Object.entries(parsed.spec.env)) {
			if (typeof value !== "string") throw new Error(`omp ps returned a non-string environment value for service ${name}`);
			env[key] = value;
		}
	}
	return { state, spec: { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) } };
}

function localHubUrl(info: OmpServiceInfo): string {
	const env = info.spec?.env ?? {};
	const rawHost = env.HOST?.trim() || "127.0.0.1";
	const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
	const port = env.PORT?.trim() || "8080";
	const scheme = env.HUB_TLS_CERT && env.HUB_TLS_KEY ? "https" : "http";
	return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

async function hubJson(hubUrl: string, token: string, route: string): Promise<unknown> {
	const response = await fetch(new URL(route, `${hubUrl.replace(/\/+$/, "")}/`), {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
	return response.json();
}

async function machines(hubUrl: string, token: string): Promise<MachineRecord[]> {
	const body = await hubJson(hubUrl, token, "/api/machines");
	if (body === null || typeof body !== "object" || !("machines" in body) || !Array.isArray(body.machines)) {
		throw new Error("/api/machines returned a malformed response");
	}
	const records: MachineRecord[] = [];
	for (const item of body.machines) {
		if (
			item === null ||
			typeof item !== "object" ||
			!("machineId" in item) ||
			typeof item.machineId !== "string" ||
			!("connected" in item) ||
			typeof item.connected !== "boolean"
		) {
			throw new Error("/api/machines returned a malformed machine");
		}
		records.push({ machineId: item.machineId, connected: item.connected });
	}
	return records;
}

async function runtimeAccess(
	options: CliOptions,
	serviceDir: string,
): Promise<RuntimeAccess> {
	const info = await readServiceInfo(options.hubService, serviceDir);
	const token = process.env.HUB_TOKEN?.trim() || info.spec?.env?.HUB_TOKEN?.trim() || "";
	if (!token) throw new Error("HUB_TOKEN is unavailable in the environment and supervised hub specification");
	const hubUrl = options.hubUrl?.replace(/\/+$/, "") || localHubUrl(info);
	const connectedMachineIds = (await machines(hubUrl, token)).filter(machine => machine.connected).map(machine => machine.machineId);
	return { hubUrl, token, connectedMachineIds };
}

function activeSessionError(active: readonly SessionSummary[]): Error {
	const details = active.map(session => `${session.id} ${session.status} ${JSON.stringify(session.name)}`).join("\n");
	return new Error(
		`refusing a disruptive deploy with ${active.length} active session(s):\n${details}\n` +
		"stop or drain them first; --force-active deliberately overrides this guard",
	);
}

async function assertNoActiveSessions(access: RuntimeAccess, force: boolean): Promise<void> {
	const active = findActiveSessions(await hubJson(access.hubUrl, access.token, "/api/sessions"));
	if (active.length === 0) return;
	if (!force) throw activeSessionError(active);
	process.stderr.write(`warning: forcing deployment with ${active.length} active session(s)\n`);
}

async function waitUntil(label: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(250);
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(`timeout waiting for ${label}${detail}`);
}

async function waitForService(name: string, serviceDir: string, timeoutMs: number): Promise<void> {
	await waitUntil(`${name} readiness`, timeoutMs, async () => (await readServiceInfo(name, serviceDir)).state === "ready");
}

async function waitForHub(access: RuntimeAccess, timeoutMs: number): Promise<void> {
	await waitUntil("hub health", timeoutMs, async () => {
		const response = await fetch(new URL("/healthz", `${access.hubUrl}/`), { signal: AbortSignal.timeout(3_000) });
		return response.ok && (await response.text()) === "ok";
	});
}

async function waitForMachines(access: RuntimeAccess, timeoutMs: number): Promise<void> {
	if (access.connectedMachineIds.length === 0) return;
	await waitUntil("agent reconnection", timeoutMs, async () => {
		const online = new Set((await machines(access.hubUrl, access.token)).filter(machine => machine.connected).map(machine => machine.machineId));
		return access.connectedMachineIds.every(machineId => online.has(machineId));
	});
}

async function serviceAction(action: "stop" | "restart", name: string, serviceDir: string): Promise<void> {
	await runCommand(["omp", "ps", action, name, `--dir=${serviceDir}`], serviceDir);
}

/**
 * Starts both new processes before awaiting readiness: the agent's readiness
 * condition may require a live hub connection.
 */
export async function coordinatedRestart(ops: CoordinatedRestartOps): Promise<void> {
	await ops.restartAgent();
	await ops.restartHub();
	await ops.waitForHub();
	await ops.waitForAgent();
}

async function buildWebRelease(repoRoot: string, releaseRoot: string, commit: string): Promise<WebBuild> {
	const releases = path.join(releaseRoot, "web-releases");
	const releasePath = path.join(releases, commit);
	if ((await pathKind(releasePath)) === "directory") return { releasePath };

	await mkdir(releases, { recursive: true });
	const temporary = path.join(releases, `${commit}.tmp-${process.pid}-${crypto.randomUUID()}`);
	const webRoot = path.join(repoRoot, "packages/web");
	await rm(temporary, { recursive: true, force: true });
	try {
		await runCommand(["bun", "install", "--frozen-lockfile"], webRoot);
		await runCommand(
			[
				"bun",
				"build",
				"./index.html",
				`--outdir=${temporary}`,
				"--minify",
				"--public-path=/",
				"--entry-naming=[hash].[ext]",
				"--chunk-naming=[hash].[ext]",
				"--asset-naming=[hash].[ext]",
			],
			webRoot,
		);
		const html = (await readdir(temporary)).filter(file => file.endsWith(".html"));
		if (html.length !== 1) throw new Error(`web build produced ${html.length} HTML entry files`);
		await rename(path.join(temporary, html[0]!), path.join(temporary, "index.html"));
		for (const entry of await readdir(path.join(webRoot, "public"))) {
			await cp(path.join(webRoot, "public", entry), path.join(temporary, entry), { recursive: true });
		}
		const index = await readFile(path.join(temporary, "index.html"), "utf8");
		if (!index.includes("<script") || !index.includes("stylesheet")) throw new Error("web build index is missing scripts or styles");
		await writeFile(path.join(temporary, ".deploy-commit"), `${commit}\n`);
		await rename(temporary, releasePath);
		return { releasePath };
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

function componentLabel(plan: DeployComponents): string {
	const names = (["web", "hub", "agent"] as const).filter(name => plan[name]);
	return names.length > 0 ? names.join(", ") : "none";
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}

	const repoRoot = await captureCommand(["git", "rev-parse", "--show-toplevel"], process.cwd());
	const serviceDir = path.resolve(options.serviceDir ?? repoRoot);
	const commonGitDirRaw = await git(repoRoot, "rev-parse", "--git-common-dir");
	const commonGitDir = path.resolve(repoRoot, commonGitDirRaw);
	const deployRoot = path.resolve(options.deployRoot ?? path.join(commonGitDir, "omp-hub-demo"));
	const stateFile = path.resolve(options.stateFile ?? path.join(deployRoot, "state.json"));
	const target = await resolveCommit(repoRoot, "HEAD");
	await assertDeployableWorktree(repoRoot);
	let state = await readState(stateFile);
	if (options.recordCurrent) {
		const recorded = initialState(target);
		if (state?.webRelease) recorded.webRelease = state.webRelease;
		if (state?.previousWebRelease) recorded.previousWebRelease = state.previousWebRelease;
		state = recorded;
		await writeState(stateFile, state);
		process.stdout.write(`recorded ${target.slice(0, 12)} as deployed; no processes changed\n`);
		return;
	}
	if (options.rollbackWeb) {
		if (state === null || !state.previousWebRelease) throw new Error("no previous Web release is recorded");
		const previousRelease = state.previousWebRelease;
		const previousCommit = (await readFile(path.join(previousRelease, ".deploy-commit"), "utf8")).trim();
		await resolveCommit(repoRoot, previousCommit);
		await switchWebDist(path.join(repoRoot, "packages/web/dist"), previousRelease, path.join(deployRoot, "backups"));
		state.previousWebRelease = state.webRelease;
		state.webRelease = previousRelease;
		state.components.web = previousCommit;
		await writeState(stateFile, state);
		process.stdout.write(`web: rolled back to ${previousCommit.slice(0, 12)}\n`);
		return;
	}
	if (state === null) {
		if (!options.from) throw new Error(`deployment state does not exist: pass --from <currently-deployed-commit> or --record-current`);
		state = initialState(await resolveCommit(repoRoot, options.from));
	} else if (options.from) {
		throw new Error("--from is only valid before deployment state exists");
	}

	for (const commit of Object.values(state.components)) await resolveCommit(repoRoot, commit);
	const webFiles = await changedPaths(repoRoot, state.components.web, target);
	const hubFiles = await changedPaths(repoRoot, state.components.hub, target);
	const agentFiles = await changedPaths(repoRoot, state.components.agent, target);
	const plan: DeployComponents = {
		web: classifyChangedPaths(webFiles).web,
		hub: classifyChangedPaths(hubFiles).hub,
		agent: classifyChangedPaths(agentFiles).agent,
	};
	const distPath = path.join(repoRoot, "packages/web/dist");
	const distKind = await pathKind(distPath);
	if (distKind === "other") throw new Error(`web dist is neither a directory nor symlink: ${distPath}`);
	const migrateWebDist = plan.web && distKind === "directory";
	const restartHub = plan.hub || migrateWebDist;
	const disruptive = restartHub || plan.agent;

	process.stdout.write(`target: ${target.slice(0, 12)}\ncomponents: ${componentLabel(plan)}\n`);
	if (migrateWebDist) process.stdout.write("hub restart: required once to migrate packages/web/dist to atomic releases\n");

	let access: RuntimeAccess | undefined;
	if (disruptive) {
		access = await runtimeAccess(options, serviceDir);
		if (plan.agent) await readServiceInfo(options.agentService, serviceDir);
		await assertNoActiveSessions(access, options.forceActive);
	}
	if (options.dryRun) {
		process.stdout.write("dry-run: no files or processes changed\n");
		return;
	}

	if (!plan.web && !plan.hub && !plan.agent) {
		state.components = { web: target, hub: target, agent: target };
		await writeState(stateFile, state);
		process.stdout.write("no runtime changes; deployment state advanced\n");
		return;
	}

	let webBuild: WebBuild | undefined;
	if (plan.web) webBuild = await buildWebRelease(repoRoot, deployRoot, target);
	if ((await resolveCommit(repoRoot, "HEAD")) !== target) {
		throw new Error("HEAD changed while the release was being prepared; rerun deployment");
	}
	if (disruptive && access) await assertNoActiveSessions(access, options.forceActive);

	let hubStopped = false;
	try {
		const needsCoordinatedRestart = plan.agent && restartHub;
		if (migrateWebDist || needsCoordinatedRestart) {
			await serviceAction("stop", options.hubService, serviceDir);
			hubStopped = true;
		}

		if (webBuild) {
			const webChange = await switchWebDist(distPath, webBuild.releasePath, path.join(deployRoot, "backups"));
			if (webChange.previous.kind === "symlink") {
				state.previousWebRelease = path.resolve(path.dirname(distPath), webChange.previous.target);
			} else if (state.webRelease) {
				state.previousWebRelease = state.webRelease;
			}
			state.webRelease = webBuild.releasePath;
			state.components.web = target;
			await writeState(stateFile, state);
			process.stdout.write(`web: switched to ${target.slice(0, 12)}\n`);
		}

		if (needsCoordinatedRestart) {
			await coordinatedRestart({
				restartAgent: () => serviceAction("restart", options.agentService, serviceDir),
				restartHub: async () => {
					await serviceAction("restart", options.hubService, serviceDir);
					hubStopped = false;
				},
				waitForHub: async () => {
					await waitForService(options.hubService, serviceDir, options.timeoutMs);
					await waitForHub(access!, options.timeoutMs);
				},
				waitForAgent: async () => {
					await waitForService(options.agentService, serviceDir, options.timeoutMs);
					await waitForMachines(access!, options.timeoutMs);
				},
			});
			state.components.agent = target;
			state.components.hub = target;
			await writeState(stateFile, state);
			process.stdout.write(`agent: restarted at ${target.slice(0, 12)}\n`);
			process.stdout.write(`hub: restarted at ${target.slice(0, 12)}\n`);
		} else {
			if (restartHub) {
				await serviceAction("restart", options.hubService, serviceDir);
				hubStopped = false;
				await waitForService(options.hubService, serviceDir, options.timeoutMs);
				await waitForHub(access!, options.timeoutMs);
				await waitForMachines(access!, options.timeoutMs);
				state.components.hub = target;
				await writeState(stateFile, state);
				process.stdout.write(`hub: restarted at ${target.slice(0, 12)}\n`);
			}
			if (plan.agent) {
				await assertNoActiveSessions(access!, options.forceActive);
				await serviceAction("restart", options.agentService, serviceDir);
				await waitForService(options.agentService, serviceDir, options.timeoutMs);
				await waitForMachines(access!, options.timeoutMs);
				state.components.agent = target;
				await writeState(stateFile, state);
				process.stdout.write(`agent: restarted at ${target.slice(0, 12)}\n`);
			}
		}

		if (!plan.web) state.components.web = target;
		if (!plan.hub) state.components.hub = target;
		if (!plan.agent) state.components.agent = target;
		await writeState(stateFile, state);
		process.stdout.write(`deployed ${target.slice(0, 12)}\n`);
	} catch (error) {
		if (hubStopped) {
			try {
				await serviceAction("restart", options.hubService, serviceDir);
			} catch (recoveryError) {
				process.stderr.write(`hub recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}\n`);
			}
		}
		throw error;
	}
}

if (import.meta.main) {
	void main().catch(error => {
		process.stderr.write(`deploy-demo: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
