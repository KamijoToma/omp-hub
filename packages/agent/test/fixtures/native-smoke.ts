import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "../../../hub/src/server";

const machineId = "native-release-smoke";
const token = "native-release-smoke-token";
const timeoutMs = 90_000;

async function until<T>(label: string, probe: () => Promise<T | null>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await probe();
		if (result !== null) return result;
		await Bun.sleep(100);
	}
	throw new Error(`${label} did not complete within ${timeoutMs / 1000}s`);
}

interface SessionReply {
	status: string;
	error?: string;
	exitReason?: string;
	fullLink?: string;
}

function readSession(raw: unknown): SessionReply {
	if (!raw || typeof raw !== "object" || !("session" in raw)) throw new Error("hub returned no session");
	const value = raw.session;
	if (!value || typeof value !== "object" || !("status" in value) || typeof value.status !== "string") {
		throw new Error("hub returned an invalid session");
	}
	const error = "error" in value && typeof value.error === "string" ? value.error : undefined;
	const exitReason = "exitReason" in value && typeof value.exitReason === "string" ? value.exitReason : undefined;
	const links = "links" in value ? value.links : undefined;
	const fullLink = links && typeof links === "object" && "full" in links && typeof links.full === "string"
		? links.full
		: undefined;
	return { status: value.status, error, exitReason, fullLink };
}

function readMachine(raw: unknown): { connected: boolean; connectedAt: number } | null {
	if (!raw || typeof raw !== "object" || !("machines" in raw) || !Array.isArray(raw.machines)) {
		throw new Error("hub returned an invalid machine list");
	}
	const machines: unknown[] = raw.machines;
	for (const entry of machines) {
		if (!entry || typeof entry !== "object" || !("machineId" in entry) || entry.machineId !== machineId) continue;
		if (!("connected" in entry) || typeof entry.connected !== "boolean" ||
			!("connectedAt" in entry) || typeof entry.connectedAt !== "number") {
			throw new Error("hub returned invalid machine status");
		}
		return { connected: entry.connected, connectedAt: entry.connectedAt };
	}
	return null;
}

const input = process.argv[2];
if (!input || process.argv.length !== 3) throw new Error("usage: bun packages/agent/test/fixtures/native-smoke.ts <native-build-directory>");
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("native smoke requires linux-x64");

const root = await mkdtemp(path.join(tmpdir(), "omp-hub-native-smoke-"));
const payload = path.join(root, "payload");
const home = path.join(root, "home");
const project = path.join(root, "project");
const bin = path.join(payload, "omp-hub-agent");
let groupPid: number | undefined;
const hub = startHub({ port: 0, hostname: "127.0.0.1", token });
try {
	await cp(path.resolve(input), payload, { recursive: true });
	for (const name of ["omp-hub-agent", "omp-hub-agent-session", "omp-hub-agent-stats", "pi_natives.linux-x64-baseline.node"]) {
		const info = await lstat(path.join(payload, name));
		if (!info.isFile()) throw new Error(`native build is missing a regular ${name}`);
	}
	await mkdir(path.join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
	await mkdir(project, { recursive: true });
	const authorization = { Authorization: `Bearer ${token}` };
	const request = async (url: string, init: RequestInit = {}): Promise<Response> =>
			fetch(`${hub.url}${url}`, {
				...init,
				headers: { ...authorization, ...init.headers },
				signal: AbortSignal.timeout(25_000),
			});
	const daemon = Bun.spawn(["setsid", bin, "--hub", hub.url, "--machine-id", machineId], {
		cwd: project,
		env: { ...process.env, HOME: home, HUB_TOKEN: token, PATH: "/usr/bin:/bin" },
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	groupPid = daemon.pid;
	const machine = async (): Promise<{ connected: boolean; connectedAt: number } | null> => {
		const response = await request("/api/machines");
		if (!response.ok) throw new Error(`machine list: HTTP ${response.status}`);
		return readMachine(await response.json());
	};
	const connected = await until("daemon connect", async () => {
		const current = await machine();
		return current?.connected ? current : null;
	});

	const created = await request("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ machineId, cwd: project }),
	});
	if (created.status !== 202) throw new Error(`session start: HTTP ${created.status} ${await created.text()}`);
	const createdBody: unknown = await created.json();
	if (!createdBody || typeof createdBody !== "object" || !("session" in createdBody) ||
		!createdBody.session || typeof createdBody.session !== "object" ||
		!("id" in createdBody.session) || typeof createdBody.session.id !== "string") {
		throw new Error("hub returned no created session id");
	}
	const id = createdBody.session.id;
	const live = await until("compiled session ready", async () => {
		const response = await request(`/api/sessions/${id}`);
		const session = readSession(await response.json());
		if (session.status === "failed" || session.status === "exited") {
			throw new Error(`compiled session ${session.status}: ${session.error ?? session.exitReason ?? "unknown"}`);
		}
		return session.status === "live" ? session : null;
	});
	if (!live.fullLink) throw new Error("compiled session produced no writable link");
	const state = await request(`/api/sessions/${id}/agent-state`);
	const stateBody: unknown = await state.json();
	if (!state.ok || !stateBody || typeof stateBody !== "object" || !("ok" in stateBody) || stateBody.ok !== true) {
		throw new Error(`compiled session get-state: HTTP ${state.status}`);
	}

	for (const [endpoint, expectedType] of [
		["/api/stats", "application/json"],
		["/index.html", "text/html"],
		["/index.js", "javascript"],
		["/index.css", "text/css"],
	] as const) {
		const result = await request(`/api/machines/${machineId}/usage${endpoint}?profile=work`);
		if (!result.ok) throw new Error(`named-profile stats ${endpoint}: HTTP ${result.status} ${await result.text()}`);
		if (!result.headers.get("content-type")?.includes(expectedType)) {
			throw new Error(`named-profile stats ${endpoint} did not serve ${expectedType}`);
		}
		if (endpoint === "/index.html") {
			if (!(await result.text()).includes("src=\"index.js\"")) throw new Error("compiled stats client script is missing");
		} else {
			await result.body?.cancel();
		}
	}
	const stop = await request(`/api/sessions/${id}/stop`, { method: "POST" });
	if (!stop.ok) throw new Error(`session stop: HTTP ${stop.status} ${await stop.text()}`);
	await until("compiled session stopped", async () => {
		const response = await request(`/api/sessions/${id}`);
		const session = readSession(await response.json());
		return session.status === "exited" ? true : null;
	});

	const restart = await request(`/api/machines/${machineId}/restart-daemon`, { method: "POST" });
	if (!restart.ok) throw new Error(`daemon restart: HTTP ${restart.status} ${await restart.text()}`);
	await until("compiled daemon replacement", async () => {
		const current = await machine();
		return current?.connected && current.connectedAt > connected.connectedAt ? true : null;
	});
	console.log("native archive smoke: session ready/state/stop, named stats API+UI, daemon restart OK");
} finally {
	if (groupPid !== undefined) {
		try { process.kill(-groupPid, "SIGTERM"); } catch { /* The process group already exited. */ }
	}
	hub.stop();
	await rm(root, { recursive: true, force: true });
}
