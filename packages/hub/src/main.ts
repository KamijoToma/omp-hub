/**
 * Hub process entry: env/argv handling, signal lifecycle, upgrade-restart
 * bind wait, and the dev `--watch` hot reload. Library code lives in
 * `server.ts` (kept free of `import.meta.main` side effects so the watcher
 * can re-import it safely under a cache-busting query).
 */
import { watch as watchFs } from "node:fs";
import { tlsConfigured, type Config } from "./config";
import { log } from "./log";
import { buildHub, hubView, startHub, ReloadableServer, type Hub, type HubCore, type HubSocketData } from "./server";

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
	watchFs(new URL(".", import.meta.url).pathname, { recursive: true }, schedule);
	log.info("hot reload armed (--watch): src/ changes swap handlers in place");

	async function reloadNow(): Promise<void> {
		if (reloading) return;
		reloading = true;
		try {
			// Cache-busting query: Bun treats the specifier as a fresh module.
			const fresh = (await import(`./server.ts?v=${Date.now()}`)) as typeof import("./server.ts");
			const next: HubCore = fresh.buildHub(watchOverrides, { restoreState: false });
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
