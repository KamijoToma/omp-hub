/**
 * Stable machine identity for the agent channel (`hello.machineId`).
 *
 * Resolution order: `--machine-id` flag > `AGENT_MACHINE_ID` env > persisted
 * JSON at ~/.omp-hub-agent.json (created on first run as `m_` + 10 base36 chars).
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENV_VAR = "AGENT_MACHINE_ID";
const FILE_NAME = ".omp-hub-agent.json";
const ID_PREFIX = "m_";
const ID_LENGTH = 10;
const BASE36 = 36;

export interface PersistedAgentFile {
	machineId: string;
	createdAt: string;
}

/** Absolute path of the persisted agent identity file. */
export function machineIdFile(): string {
	return join(homedir(), FILE_NAME);
}

function mintMachineId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	const digits = value.toString(BASE36).padStart(ID_LENGTH, "0");
	return `${ID_PREFIX}${digits.slice(0, ID_LENGTH)}`;
}

function persistedId(parsed: unknown): string | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const value = (parsed as Partial<PersistedAgentFile>).machineId;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve this machine's id, creating the persisted file when nothing supplies one.
 */
export async function resolveMachineId(flagValue?: string): Promise<string> {
	const fromFlag = flagValue?.trim();
	if (fromFlag) return fromFlag;

	const fromEnv = process.env[ENV_VAR]?.trim();
	if (fromEnv) return fromEnv;

	const file = machineIdFile();
	if (await Bun.file(file).exists()) {
		const existing = await Bun.file(file)
			.text()
			.then(text => persistedId(JSON.parse(text) as unknown))
			.catch(() => undefined);
		if (existing) return existing;
	}

	const created: PersistedAgentFile = { machineId: mintMachineId(), createdAt: new Date().toISOString() };
	await mkdir(dirname(file), { recursive: true });
	await Bun.write(file, `${JSON.stringify(created, null, 2)}\n`);
	return created.machineId;
}
