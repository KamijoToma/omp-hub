import path from "node:path";
import { isCompiledAgent } from "./native-mode";
import { applyProfileSelection, defaultProfilesRoot, normalizeProfileName, profileExists } from "./profiles";
import type { SubscriptionUsage } from "./subscriptions-worker";

/** Longer than the ordinary command budget: providers may require multiple remote quota requests. */
export const SUBSCRIPTIONS_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function subscriptionWorkerCommand(execPath = process.execPath, compiled = isCompiledAgent): string[] {
	return compiled
		? [path.join(path.dirname(execPath), "omp-hub-agent-subscriptions")]
		: [execPath, new URL("./subscriptions-worker.ts", import.meta.url).pathname];
}

/** A fresh child for each request prevents SDK's module-load profile state from bleeding between profiles. */
export async function getSubscriptions(rawProfile: unknown, profilesRoot = defaultProfilesRoot()): Promise<SubscriptionUsage> {
	if (rawProfile !== undefined && typeof rawProfile !== "string") throw new Error("invalid profile name");
	let profile: string | undefined;
	try {
		profile = normalizeProfileName(rawProfile);
		if (rawProfile === "all" || (rawProfile !== undefined && rawProfile !== "default"
			&& (rawProfile.length === 0 || profile !== rawProfile))) {
			throw new Error("invalid profile name");
		}
	} catch {
		throw new Error("invalid profile name");
	}
	if (profile && !(await profileExists(profile, profilesRoot))) throw new Error("profile not found");
	const env: Record<string, string | undefined> = { ...process.env };
	applyProfileSelection(env, profile);
	const child = Bun.spawn(subscriptionWorkerCommand(), {
		env,
		stdout: "pipe",
		stderr: "ignore", // SDK/provider errors may embed credentials or raw HTTP responses.
		stdin: "ignore",
	});
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, SUBSCRIPTIONS_TIMEOUT_MS);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("subscription response too large");
			chunks.push(value);
		}
		const exitCode = await child.exited;
		if (timedOut) throw new Error("subscription timeout");
		if (exitCode !== 0) throw new Error("subscription usage unavailable");
		const output = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed: unknown = JSON.parse(new TextDecoder().decode(output));
		if (!parsed || typeof parsed !== "object" || !("reports" in parsed) || !Array.isArray(parsed.reports)
			|| !("unavailable" in parsed) || !Array.isArray(parsed.unavailable)
			|| !("fetchedAt" in parsed) || typeof parsed.fetchedAt !== "number") {
			throw new Error("invalid subscription response");
		}
		return parsed as SubscriptionUsage;
	} catch (error) {
		if (timedOut) throw new Error("subscription timeout");
		if (error instanceof Error && (error.message === "subscription response too large" || error.message === "subscription usage unavailable"
			|| error.message === "invalid subscription response")) throw error;
		throw new Error("subscription usage unavailable");
	} finally {
		clearTimeout(timer);
		child.kill();
		void reader.cancel().catch(() => {});
	}
}
