/**
 * Machine-level `usage-req` handling (docs/protocol.md §2): relays HTTP reads
 * to the machine-local omp stats dashboard. The daemon is outbound-only, so
 * the hub reaches the dashboard (127.0.0.1:3847 by default) only through this
 * tunnel. The dashboard is started lazily on first request — `startServer()`
 * reuses a live one, reclaims a stale listener, or binds a fresh one — and
 * reused for later requests.
 */

import type { UsageReqFrame, UsageResultFrame } from "./hub-client";
import { errorMessage } from "./log";

/** Resolves the dashboard origin, e.g. `http://127.0.0.1:3847`. */
export type StatsOriginResolver = () => Promise<string>;

/** Answers one `usage-req`; the returned frame is the wire-ready `usage-res`. */
export type UsageProxy = (frame: UsageReqFrame) => Promise<UsageResultFrame>;

export interface UsageProxyOptions {
	/** Defaults to the sibling checkout's `@oh-my-pi/omp-stats` `startServer()`. */
	resolveOrigin?: StatsOriginResolver;
	/** Relay cap; a larger dashboard response fails the request. Default 8 MiB. */
	maxBodyBytes?: number;
}

const ALLOWED_METHODS: Record<string, true> = { GET: true, HEAD: true, POST: true };
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 2048;

let defaultOrigin: Promise<string> | null = null;

/**
 * Dashboard launcher used by default, cached until it fails: a broken
 * environment (missing sibling checkout, unwritable state) is retried on the
 * next request instead of poisoning every later one.
 */
function resolveDefaultOrigin(): Promise<string> {
	defaultOrigin ??= import("@oh-my-pi/omp-stats")
		.then(stats => stats.startServer())
		.then(handle => `http://${handle.hostname}:${handle.port}`)
		.catch((error: unknown) => {
			defaultOrigin = null;
			throw error;
		});
	return defaultOrigin;
}

export function createUsageProxy(options: UsageProxyOptions = {}): UsageProxy {
	const resolveOrigin = options.resolveOrigin ?? resolveDefaultOrigin;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

	return async frame => {
		if (ALLOWED_METHODS[frame.method] !== true) {
			return { t: "usage-res", reqId: frame.reqId, ok: false, error: `method not allowed: ${String(frame.method)}` };
		}
		// The forward target is always the loopback dashboard: the path must stay
		// a relative absolute-path (no scheme, no authority, no backslashes).
		const path = frame.path;
		if (
			typeof path !== "string" ||
			!path.startsWith("/") ||
			path.startsWith("//") ||
			path.includes("\\") ||
			/[\u0000-\u001f\u007f]/.test(path) ||
			path.length > MAX_PATH_LENGTH
		) {
			return { t: "usage-res", reqId: frame.reqId, ok: false, error: "invalid usage path" };
		}
		if (frame.bodyB64 !== undefined && frame.method !== "POST") {
			return { t: "usage-res", reqId: frame.reqId, ok: false, error: "request body requires POST" };
		}
		let body: Uint8Array | undefined;
		if (typeof frame.bodyB64 === "string" && frame.bodyB64.length > 0) {
			body = new Uint8Array(Buffer.from(frame.bodyB64, "base64"));
			if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
				return { t: "usage-res", reqId: frame.reqId, ok: false, error: "request body too large" };
			}
		}

		let origin: string;
		try {
			origin = await resolveOrigin();
		} catch (error) {
			return { t: "usage-res", reqId: frame.reqId, ok: false, error: `stats dashboard unavailable: ${errorMessage(error)}` };
		}

		let response: Response;
		try {
			response = await fetch(`${origin}${path}`, {
				method: frame.method,
				headers: body ? { "content-type": "application/json" } : undefined,
				body: frame.method === "POST" ? body : undefined,
			});
		} catch (error) {
			return { t: "usage-res", reqId: frame.reqId, ok: false, error: `stats request failed: ${errorMessage(error)}` };
		}

		const contentType = response.headers.get("content-type") ?? undefined;
		if (frame.method === "HEAD" || response.status === 204 || response.status === 304) {
			await response.body?.cancel();
			return { t: "usage-res", reqId: frame.reqId, ok: true, status: response.status, ...(contentType ? { contentType } : {}) };
		}

		// Stream with a hard cap: the dashboard is trusted, but `range=all`
		// payloads are unbounded and the relay must not buffer them whole.
		try {
			const reader = response.body?.getReader();
			if (!reader) {
				return { t: "usage-res", reqId: frame.reqId, ok: true, status: response.status, ...(contentType ? { contentType } : {}) };
			}
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > maxBodyBytes) {
					await reader.cancel();
					return { t: "usage-res", reqId: frame.reqId, ok: false, error: `stats response exceeds ${maxBodyBytes} bytes` };
				}
				chunks.push(value);
			}
			const merged = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return {
				t: "usage-res",
				reqId: frame.reqId,
				ok: true,
				status: response.status,
				...(contentType ? { contentType } : {}),
				...(total === 0 ? {} : { bodyB64: Buffer.from(merged).toString("base64") }),
			};
		} catch (error) {
			return { t: "usage-res", reqId: frame.reqId, ok: false, error: `stats read failed: ${errorMessage(error)}` };
		}
	};
}
