/**
 * Hub process configuration (env-driven; docs/architecture.md §1, docs/protocol.md §3).
 * Bun builtins only — the hub has zero runtime dependencies.
 */
import { statSync } from "node:fs";
import path from "node:path";
import pkg from "../package.json";

export interface Config {
	/** TCP port; `0` picks a free port (tests). */
	readonly port: number;
	readonly hostname: string;
	/** Shared token for the agent channel and `/api/*`. Empty ⇒ hub runs open (dev only). */
	readonly token: string;
	/** Public origin (e.g. `https://hub.lan`); when set it wins over the request Host header. */
	readonly publicUrl: string;
	readonly tlsCert: string | null;
	readonly tlsKey: string | null;
	/** Directory served for `/*` with SPA fallback. */
	readonly webDist: string;
	readonly version: string;
	/** How long a `/api/sessions/:id/*` command waits for the agent's `cmd-result`. */
	readonly cmdTimeoutMs: number;
}

export interface PublicBase {
	/** `https://host[:port]` — used as `webUrl`. */
	httpBase: string;
	/** `wss://host[:port]` — used as `relayUrl`. */
	wsBase: string;
}

const DEFAULT_PORT = 8080;
const DEFAULT_HOSTNAME = "0.0.0.0";
/** Protocol §2: a pending `cmd` is abandoned after 15 s. */
const DEFAULT_CMD_TIMEOUT_MS = 15_000;

/** Built web assets: `<hub pkg>/web/dist`, falling back to the sibling `<repo>/packages/web/dist`. */
const PACKAGE_WEB_DIST = path.resolve(import.meta.dir, "../web/dist");
const SIBLING_WEB_DIST = path.resolve(import.meta.dir, "../../web/dist");

function readPort(raw: string | undefined): number {
	const value = raw?.trim();
	if (!value) return DEFAULT_PORT;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`invalid PORT "${raw}" (expected an integer 0-65535)`);
	}
	return port;
}

function readCmdTimeout(raw: string | undefined): number {
	const value = raw?.trim();
	if (!value) return DEFAULT_CMD_TIMEOUT_MS;
	const ms = Number(value);
	if (!Number.isInteger(ms) || ms <= 0) {
		throw new Error(`invalid HUB_CMD_TIMEOUT_MS "${raw}" (expected a positive integer of milliseconds)`);
	}
	return ms;
}

function resolveWebDist(raw: string | undefined): string {
	const value = raw?.trim();
	if (value) return path.resolve(value);
	const candidates = [PACKAGE_WEB_DIST, SIBLING_WEB_DIST];
	const existing = candidates.find((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);
	return existing ?? PACKAGE_WEB_DIST;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const tlsPaths = [env.HUB_TLS_CERT, env.HUB_TLS_KEY].map((raw) => {
		const value = raw?.trim();
		return value ? path.resolve(value) : null;
	});
	const tlsCert = tlsPaths[0] ?? null;
	const tlsKey = tlsPaths[1] ?? null;
	if ((tlsCert === null) !== (tlsKey === null)) {
		throw new Error("HUB_TLS_CERT and HUB_TLS_KEY must be set together");
	}
	return {
		port: readPort(env.PORT),
		hostname: env.HOST?.trim() || DEFAULT_HOSTNAME,
		token: env.HUB_TOKEN ?? "",
		publicUrl: (env.HUB_PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
		tlsCert,
		tlsKey,
		webDist: resolveWebDist(env.WEB_DIST),
		version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
		cmdTimeoutMs: readCmdTimeout(env.HUB_CMD_TIMEOUT_MS),
	};
}

export function tlsConfigured(cfg: Config): boolean {
	return cfg.tlsCert !== null && cfg.tlsKey !== null;
}

/**
 * Public origin minted into `start`/`welcome` links: `HUB_PUBLIC_URL` when configured,
 * otherwise this request's Host header plus whether the hub itself terminates TLS.
 */
export function derivePublicBase(req: Request, cfg: Config): PublicBase {
	const url = new URL(req.url);
	const scheme = tlsConfigured(cfg) ? "https" : url.protocol === "https:" ? "https" : "http";
	const host = req.headers.get("host")?.trim() || url.host;
	const httpBase = cfg.publicUrl || `${scheme}://${host}`;
	// `https` → `wss`, `http` → `ws`.
	return { httpBase, wsBase: httpBase.replace(/^http/, "ws") };
}
