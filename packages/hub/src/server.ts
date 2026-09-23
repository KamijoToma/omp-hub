/**
 * omp-hub server entry — one Bun process, one port (docs/architecture.md §1).
 *
 * Routing order: `/healthz` → `/agent` upgrade → `/r/` upgrade → `/api/*` → static SPA.
 */
import { AgentRegistry, type AgentSocket, type AgentSocketData } from "./agents";
import { handleApi } from "./api";
import { loadConfig, tlsConfigured, type Config } from "./config";
import { log } from "./log";
import { CollabRelay, type RelaySocket, type RelaySocketData } from "./relay";
import { SessionStore } from "./sessions";
import { serveStatic } from "./static";

export type HubSocketData = RelaySocketData | AgentSocketData;

export interface Hub {
	readonly cfg: Config;
	readonly server: Bun.Server<HubSocketData>;
	readonly sessions: SessionStore;
	readonly agents: AgentRegistry;
	readonly relay: CollabRelay;
	readonly port: number;
	/** `http(s)://host:port` — the origin the hub answers on. */
	readonly url: string;
	/** Stops the timers, closes the rooms and the listener. Idempotent. */
	stop(): void;
}

// The websocket handlers are shared by both socket kinds, so the dispatch narrows on
// `data.kind` and re-types the socket at that single boundary.
const asRelaySocket = (ws: Bun.ServerWebSocket<HubSocketData>): RelaySocket => ws as unknown as RelaySocket;
const asAgentSocket = (ws: Bun.ServerWebSocket<HubSocketData>): AgentSocket => ws as unknown as AgentSocket;

export function startHub(overrides: Partial<Config> = {}): Hub {
	const cfg: Config = { ...loadConfig(), ...overrides };
	const sessions = new SessionStore();
	const relay = new CollabRelay();
	const agents = new AgentRegistry(cfg, sessions);

	const server = Bun.serve<HubSocketData>({
		hostname: cfg.hostname,
		port: cfg.port,
		...(tlsConfigured(cfg) ? { tls: { cert: Bun.file(cfg.tlsCert!), key: Bun.file(cfg.tlsKey!) } } : {}),
		fetch(req, srv): Response | Promise<Response> | undefined {
			const pathname = new URL(req.url).pathname;
			if (pathname === "/healthz") return new Response("ok");
			if (pathname === "/agent" || pathname === "/agent/") return agents.handleUpgrade(req, srv);
			if (pathname.startsWith("/r/")) return relay.handleUpgrade(req, srv);
			if (pathname === "/api" || pathname.startsWith("/api/")) {
				return handleApi(req, { cfg, sessions, agents });
			}
			return serveStatic(req, cfg);
		},
		websocket: {
			open(ws): void {
				if (ws.data.kind === "relay") relay.handleOpen(asRelaySocket(ws));
			},
			message(ws, message): void {
				if (ws.data.kind === "relay") relay.handleMessage(asRelaySocket(ws), message);
				else agents.handleMessage(asAgentSocket(ws), message);
			},
			close(ws): void {
				if (ws.data.kind === "relay") relay.handleClose(asRelaySocket(ws));
				else agents.handleClose(asAgentSocket(ws));
			},
		},
	});

	agents.start();

	const scheme = tlsConfigured(cfg) ? "https" : "http";
	// A wildcard bind is not a navigable host: report the loopback name instead.
	const host = cfg.hostname === "0.0.0.0" || cfg.hostname === "::" || cfg.hostname === "" ? "localhost" : cfg.hostname;
	// Bun types the port as optional (unix-socket listeners); the hub always binds TCP.
	const port = server.port;
	if (port === undefined) {
		agents.stop();
		server.stop(true);
		throw new Error("hub listener did not bind a TCP port");
	}
	let stopped = false;

	return {
		cfg,
		server,
		sessions,
		agents,
		relay,
		port,
		url: `${scheme}://${host}:${port}`,
		stop(): void {
			if (stopped) return;
			stopped = true;
			agents.stop();
			relay.closeAll();
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	const hub = startHub();
	log.info(`omp-hub ${hub.cfg.version} listening on ${hub.url}`);
	if (hub.cfg.token === "") {
		log.warn("!!! HUB_TOKEN IS EMPTY — THE HUB IS RUNNING OPEN (no auth on /agent or /api) !!!");
		log.warn("!!! anyone who can reach this port can start and control sessions — set HUB_TOKEN !!!");
	} else {
		log.info("token auth enabled for /agent and /api/*");
	}
	log.info(`web dist: ${hub.cfg.webDist}`);
	if (tlsConfigured(hub.cfg)) log.info(`tls: ${hub.cfg.tlsCert} + ${hub.cfg.tlsKey}`);

	const shutdown = (signal: string): void => {
		log.info(`${signal} received — shutting down`);
		hub.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
