/**
 * Hub process entry: env/argv handling, signal lifecycle, upgrade-restart
 * bind wait, and the dev `--watch` hot reload. Library code lives in
 * `server.ts` (kept free of `import.meta.main` side effects so the watcher
 * can re-import it safely under a cache-busting query).
 */
import { watch as watchFs } from "node:fs";
import { tlsConfigured, type Config } from "./config";
import { log } from "./log";
import { buildHub, hubView, isCompiledBinary, startHub, ReloadableServer, type Hub, type HubCore, type HubSocketData } from "./server";

const watch = Bun.argv.includes("--watch");
if (watch && isCompiledBinary()) {
	// The hot reload re-imports `./server.ts` with a cache-busting query — no
	// source files exist inside the compiled executable.
	process.stderr.write("--watch requires a source checkout; it is not available in the compiled binary\n");
	process.exit(1);
}
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

let shuttingDown = false;
const shutdown = (signal: string): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info(`${signal} received — shutting down`);
	void hub.core.shutdown().catch(err => {
		log.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
	}).finally(() => {
		hub.server.stop(true);
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
			next.start();
			live = hubView(live.server, next);
			hub = live; // signal shutdown must use the swapped core, not the drained one
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
