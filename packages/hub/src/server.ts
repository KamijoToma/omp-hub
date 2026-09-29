/**
 * omp-hub server entry — one Bun process, one port (docs/architecture.md §1).
 *
 * Routing order: `/healthz` → `/agent` upgrade → `/r/` (browser navigations 302 to the web
 * join UI; WebSocket upgrades hit the relay) → `/api/*` → static SPA.
 *
 * Construction is split from binding ({@link buildHub} vs {@link startHub}) so
 * the dev `--watch` mode can build a fresh core and swap it into the live
 * server via `server.reload()` — sockets and state carried over by `adopt` —
 * and so an upgrade restart can hand the registry over through the state file.
 */
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import type { AdoptedConnection, AgentRegistry, AgentSocket, AgentSocketData, MachineRecord } from "./agents";
import { AgentRegistry as AgentsRegistry } from "./agents";
import { handleApi } from "./api";
import { derivePublicBase, loadConfig, tlsConfigured, type Config } from "./config";
import { log } from "./log";
import { NoticeStore } from "./notices";
import { CollabRelay, type RelayRoom, type RelaySocket, type RelaySocketData } from "./relay";
import type { SessionRecord } from "./sessions";
import { SessionStore } from "./sessions";
import { loadStateSnapshot, StatePersistence } from "./state";
import { serveStatic } from "./static";

export type HubSocketData = RelaySocketData | AgentSocketData;

/** How often the registry snapshot is compared and written (upgrade restarts). */
const STATE_POLL_MS = 2_000;

export interface Hub {
	readonly cfg: Config;
	readonly server: Bun.Server<HubSocketData>;
	readonly sessions: SessionStore;
	readonly agents: AgentRegistry;
	readonly relay: CollabRelay;
	/** The constructed core behind the handlers — the hot-reload handover point. */
	readonly core: HubCore;
	readonly port: number;
	/** `http(s)://host:port` — the origin the hub answers on. */
	readonly url: string;
	/** Writes the registry snapshot now (restart/stop paths). */
	flushState(): Promise<void>;
	/** Stops the timers, closes the rooms and the listener. Idempotent. */
	stop(): void;
}

/**
 * One constructed hub: registries + the request/websocket handlers, without a
 * bound listener. `start`/`stopTimers` own the background timers; `drain` and
 * `adopt` move live state and sockets between cores on a hot reload.
 */
export interface HubCore {
	readonly cfg: Config;
	readonly sessions: SessionStore;
	readonly agents: AgentRegistry;
	readonly relay: CollabRelay;
	fetch(req: Request, srv: Bun.Server<HubSocketData>): Response | Promise<Response> | undefined;
	readonly websocket: Bun.WebSocketHandler<HubSocketData>;
	/** Set by the bound hub; the `/api/hub/restart` endpoint invokes it. */
	onRestart: (() => void) | null;
	start(): void;
	/** Stops timers and flushes the snapshot; sockets are left alone (handover). */
	stopTimers(): Promise<void>;
	flushState(): Promise<void>;
	/** Timers + snapshot flush + socket teardown — the full shutdown work. */
	shutdown(): Promise<void>;
	/** Live state + sockets, detached from this core. */
	drain(): AdoptedHubState;
	/** Takes over state and sockets drained from a previous core. */
	adopt(previous: AdoptedHubState): void;
}

/** Everything a running hub owns that must survive an in-place swap. */
export interface AdoptedHubState {
	machines: MachineRecord[];
	sessions: SessionRecord[];
	agentConnections: AdoptedConnection[];
	rooms: Map<string, RelayRoom>;
}

// The websocket handlers are shared by both socket kinds, so the dispatch narrows on
// `data.kind` and re-types the socket at that single boundary.
const asRelaySocket = (ws: Bun.ServerWebSocket<HubSocketData>): RelaySocket => ws as unknown as RelaySocket;
const asAgentSocket = (ws: Bun.ServerWebSocket<HubSocketData>): AgentSocket => ws as unknown as AgentSocket;

/**
 * Plain browser navigation: real relay clients (omp host/guest, the web app's
 * `GuestClient`) always send `Upgrade: websocket`. A browser that merely opens a
 * collab link would otherwise get the relay's text/plain 404/426 rejections, which
 * iOS Safari presents as a "document.txt" download instead of a page.
 */
function isBrowserNavigation(req: Request): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	if ((req.headers.get("upgrade") ?? "").trim().toLowerCase() === "websocket") return false;
	return (req.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Send browsers that open the bare collab link (`<host>/r/<roomId>.<key>`) to the
 * web join UI. The target hash uses the exact `<host><path>` format of the hub's
 * `web` links, so the join screen receives identical credentials. The relay's
 * `?role=` query is dropped — it is relay-internal and the web app infers the
 * role from the key.
 */
function joinRedirect(req: Request, cfg: Config): Response {
	const { pathname } = new URL(req.url);
	const { origin, host } = new URL(derivePublicBase(req, cfg).httpBase);
	return new Response(null, { status: 302, headers: { location: `${origin}/#${host}${pathname}` } });
}

export function buildHub(overrides: Partial<Config> = {}, opts: { restoreState?: boolean } = {}): HubCore {
	const cfg: Config = { ...loadConfig(), ...overrides };
	if (!cfg.token.trim()) throw new Error("HUB_TOKEN is required before starting the hub");
	const sessions = new SessionStore();
	const notices = new NoticeStore();
	const relay = new CollabRelay();
	const agents = new AgentsRegistry(cfg, sessions);

	const state: StatePersistence | null = cfg.stateFile === null ? null : new StatePersistence(cfg.stateFile);
	if (state !== null && opts.restoreState !== false) {
		const snapshot = loadStateSnapshot(cfg.stateFile!);
		if (snapshot !== null) {
			sessions.adopt(snapshot.sessions);
			// Machines re-register through `hello`; the restored flag is a lie
			// until then, and `connected: false` is what the API should report.
			agents.adoptMachines(snapshot.machines.map((machine) => ({ ...machine, connected: false })));
			log.info(
				`restored state: ${snapshot.sessions.length} session record(s), ${snapshot.machines.length} machine(s)`,
			);
		}
	}

	let stateTimer: Timer | null = null;
	const core: HubCore = {
		cfg,
		sessions,
		agents,
		relay,
		onRestart: null,
		fetch(req, srv): Response | Promise<Response> | undefined {
			const pathname = new URL(req.url).pathname;
			if (pathname === "/healthz") return new Response("ok");
			if (pathname === "/agent" || pathname === "/agent/") return agents.handleUpgrade(req, srv);
			if (pathname.startsWith("/r/")) {
				if (isBrowserNavigation(req)) return joinRedirect(req, cfg);
				return relay.handleUpgrade(req, srv);
			}
			if (pathname === "/api" || pathname.startsWith("/api/")) {
				return handleApi(req, { cfg, sessions, agents, notices, restart: core.onRestart ?? undefined });
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
		start(): void {
			agents.start();
			if (state !== null && stateTimer === null) {
				stateTimer = setInterval(() => {
					void state.sync(agents.listMachines(), sessions.list());
				}, STATE_POLL_MS);
			}
		},
		async stopTimers(): Promise<void> {
			await core.flushState();
			agents.stop();
			if (stateTimer !== null) {
				clearInterval(stateTimer);
				stateTimer = null;
			}
		},
		async flushState(): Promise<void> {
			if (state !== null) await state.sync(agents.listMachines(), sessions.list());
		},
		async shutdown(): Promise<void> {
			await core.flushState();
			agents.stop();
			if (stateTimer !== null) {
				clearInterval(stateTimer);
				stateTimer = null;
			}
			relay.closeAll();
		},
		drain(): AdoptedHubState {
			const drained: AdoptedHubState = {
				machines: agents.drainMachines(),
				sessions: sessions.list(),
				agentConnections: agents.drainConnections(),
				rooms: relay.drainRooms(),
			};
			// Records moved by reference: the old core must let them go.
			sessions.adopt([]);
			return drained;
		},
		adopt(previous: AdoptedHubState): void {
			// One synchronous block end to end: no frames can interleave between
			// the adoption and the handler swap in the caller.
			agents.adoptMachines(previous.machines);
			sessions.adopt(previous.sessions);
			agents.adoptConnections(previous.agentConnections);
			relay.adoptRooms(previous.rooms);
		},
	};
	return core;
}

/** `Bun.Server.reload` exists at runtime but is missing from the pinned types. */
export type ReloadableServer<SocketData> = Bun.Server<SocketData> & {
	reload(options: { fetch: Bun.Server<SocketData>["fetch"]; websocket: Bun.WebSocketHandler<SocketData> }): void;
};

/** Assembles the public {@link Hub} view over a bound server and its current core. */
export function hubView(server: Bun.Server<HubSocketData>, core: HubCore): Hub {
	const scheme = tlsConfigured(core.cfg) ? "https" : "http";
	// A wildcard bind is not a navigable host: report the loopback name instead.
	const host = core.cfg.hostname === "0.0.0.0" || core.cfg.hostname === "::" || core.cfg.hostname === "" ? "localhost" : core.cfg.hostname;
	return {
		cfg: core.cfg,
		server,
		sessions: core.sessions,
		agents: core.agents,
		relay: core.relay,
		core,
		get port() {
			// Bun types the port as optional (unix-socket listeners); the hub always binds TCP.
			return server.port!;
		},
		get url() {
			return `${scheme}://${host}:${server.port!}`;
		},
		flushState: () => core.flushState(),
		stop(): void {
			void core.shutdown().finally(() => server.stop(true));
		},
	};
}

export function startHub(overrides: Partial<Config> = {}): Hub {
	const core = buildHub(overrides);
	const server = Bun.serve<HubSocketData>({
		hostname: core.cfg.hostname,
		port: core.cfg.port,
		...(tlsConfigured(core.cfg) ? { tls: { cert: Bun.file(core.cfg.tlsCert!), key: Bun.file(core.cfg.tlsKey!) } } : {}),
		fetch(req, srv) {
			return core.fetch(req, srv);
		},
		websocket: core.websocket,
	});

	core.start();
	if (server.port === undefined) {
		void core.shutdown().finally(() => server.stop(true));
		throw new Error("hub listener did not bind a TCP port");
	}

	const hub = hubView(server, core);
	let restarting = false;
	core.onRestart = () => {
		if (restarting) return;
		restarting = true;
		log.info("restart requested — handing the registry to a fresh hub process");
		void hub
			.flushState()
			.catch(() => {})
			.finally(() => {
				try {
					// Same interpreter, same script, same env: the fresh process
					// waits for the port (`HUB_RESTART_BIND_WAIT`), so the old one
					// can release it mid-handover. The child logs to its own file —
					// inherited stdio dies with this process and would kill the
					// fresh hub on its first log line (SIGPIPE).
					const logPath = path.join(path.dirname(core.cfg.stateFile ?? "hub-state.json"), "hub-restart.log");
					const logFd = openSync(logPath, "a");
					const child = Bun.spawn([process.execPath, ...Bun.argv.slice(1)], {
						env: { ...process.env, HUB_RESTART_BIND_WAIT: "1" },
						stdio: ["ignore", logFd, logFd],
					});
					child.unref?.();
					closeSync(logFd);
				} catch (err) {
					log.error(`restart spawn failed: ${err instanceof Error ? err.message : String(err)}`);
					restarting = false;
					return;
				}
				// Let the HTTP response drain before releasing the port.
				setTimeout(() => {
					void core.shutdown().finally(() => {
						server.stop(true);
						process.exit(0);
					});
				}, 150);
			});
	};
	return hub;
}

if (import.meta.main) {
	const watch = Bun.argv.includes("--watch");
	const overrides: Partial<Config> = {
		// Real runs persist; the library default (tests) keeps the side effect off.
		stateFile: process.env.HUB_STATE_FILE?.trim() ? process.env.HUB_STATE_FILE.trim() : "hub-state.json",
	};

	let hub: Hub;
	if (process.env.HUB_RESTART_BIND_WAIT === "1") {
		// The fresh process of an upgrade restart races the old one for the
		// port; the old hub releases it only after its goodbye finishes.
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				hub = startHub(overrides);
				break;
			} catch (err) {
				if (Date.now() > deadline) throw err;
				log.info("port still held by the previous hub — waiting for the handover…");
				await Bun.sleep(100);
			}
		}
	} else {
		hub = startHub(overrides);
	}

	log.info(`omp-hub ${hub.cfg.version} listening on ${hub.url}`);
	log.info("token auth enabled for /agent and /api/*");
	log.info(`web dist: ${hub.cfg.webDist}`);
	log.info(`state file: ${hub.cfg.stateFile ?? "off"}`);
	if (tlsConfigured(hub.cfg)) log.info(`tls: ${hub.cfg.tlsCert} + ${hub.cfg.tlsKey}`);

	const shutdown = (signal: string): void => {
		log.info(`${signal} received — shutting down`);
		void hub.flushState().finally(() => {
			hub.stop();
			process.exit(0);
		});
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	if (watch) void startWatch(hub, overrides);

	/**
	 * Dev hot reload: watch `src/`, build a fresh core from the changed code,
	 * hand it the live sockets and registries, and swap the handlers in place —
	 * no connection drops, no state loss. Build + adopt + swap run in one
	 * synchronous block, so no frame can hit a half-swapped hub.
	 */
	async function startWatch(current: Hub, watchOverrides: Partial<Config>): Promise<void> {
		const { watch } = await import("node:fs");
		let live = current;
		let pending = false;
		let reloading = false;
		const schedule = (): void => {
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				void reloadNow();
			}, 120);
		};
		watch(import.meta.dir, { recursive: true }, schedule);
		log.info("hot reload armed (--watch): src/ changes swap handlers in place");

		async function reloadNow(): Promise<void> {
			if (reloading) return;
			reloading = true;
			try {
				const fresh = (await import(`./server.ts?v=${Date.now()}`)) as typeof import("./server.ts");
				const next = fresh.buildHub(watchOverrides, { restoreState: false });
				next.adopt(live.core.drain());
				const reloadable = live.server as unknown as ReloadableServer<HubSocketData>;
				reloadable.reload({ fetch: (req, srv) => next.fetch(req, srv), websocket: next.websocket });
				await live.core.stopTimers();
				live = hubView(live.server, next);
				log.info("hot reload complete — handlers swapped, sockets kept");
			} catch (err) {
				log.error(`hot reload failed (keeping the previous build): ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				reloading = false;
				if (pending) {
					pending = false;
					setTimeout(() => void reloadNow(), 50);
				}
			}
		}
	}
}
