/**
 * Daemon reconnect policy at the hub-client boundary (protocol §2): the hub's
 * watchdog "agent lost" close (1001) must be recoverable — a live daemon
 * reconnects — while protocol violations and same-machineId replacement
 * (4000) stay fatal so two daemons can never fight over one machineId.
 */
import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { HubClient } from "../src/hub-client";
import type { Logger } from "../src/log";

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error(message: string): void {} };

interface Waiter {
	target: number;
	resolve: () => void;
}

/** One hub WebSocket endpoint counting hello handshakes; closes on demand. */
function startFakeHub(): {
	port: number;
	closeLatest(code: number, reason: string): void;
	waitForHello(target: number, timeoutMs?: number): Promise<void>;
	waitForEvent(target: number, timeoutMs?: number): Promise<void>;
	eventCount(): number;
	helloCount(): number;
	stop(): void;
} {
	let count = 0;
	let eventCount = 0;
	const eventWaiters = new Set<Waiter>();
	let latest: ServerWebSocket<unknown> | null = null;
	const waiters = new Set<Waiter>();
	const bump = (): void => {
		count += 1;
		for (const waiter of [...waiters]) {
			if (count < waiter.target) continue;
			waiters.delete(waiter);
			waiter.resolve();
		}
	};
	const server = Bun.serve<Record<string, never>>({
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				latest = ws;
			},
			message(ws, message) {
				const frame = JSON.parse(String(message)) as { t?: string };
				if (frame.t === "session-event") {
					eventCount++;
					for (const waiter of [...eventWaiters]) {
						if (eventCount < waiter.target) continue;
						eventWaiters.delete(waiter);
						waiter.resolve();
					}
					return;
				}
				if (frame.t !== "hello") return;
				ws.send(JSON.stringify({ t: "welcome", relayUrl: "ws://hub", webUrl: "http://hub" }));
				bump();
			},
		},
	});
	// A served port is always bound; the generic widens it defensively.
	const port = server.port as number;
	return {
		port,
		closeLatest(code, reason) {
			try {
				latest?.close(code, reason);
			} catch {
				// Already closing.
			}
		},
		helloCount: () => count,
		eventCount: () => eventCount,
		waitForEvent(target, timeoutMs = 5_000) {
			if (eventCount >= target) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const deadline = setTimeout(() => reject(new Error(`timeout waiting for fleet event #${target}`)), timeoutMs);
			eventWaiters.add({
				target,
				resolve: () => {
					clearTimeout(deadline);
					resolve();
				},
			});
			return promise;
		},
		waitForHello(target, timeoutMs = 5_000) {
			if (count >= target) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const deadline = setTimeout(() => reject(new Error(`timeout waiting for hello #${target}`)), timeoutMs);
			waiters.add({
				target,
				resolve: () => {
					clearTimeout(deadline);
					resolve();
				},
			});
			return promise;
		},
		stop() {
			server.stop(true);
		},
	};
}

function startClient(port: number, heartbeatMs?: number): HubClient {
	return new HubClient({
		url: `ws://127.0.0.1:${port}`,
		token: "t",
		name: "reconnect-test",
		machineId: "m-test",
		log: SILENT,
		sessions: () => [],
		heartbeatMs,
		onStart: () => {},
		onStop: () => {},
		onCmd: () => {},
		onUsage: () => {},
	});
}

describe("hub client reconnect policy", () => {
	test("1001 (agent lost) is transient: the daemon reconnects", async () => {
		const hub = startFakeHub();
		const client = startClient(hub.port);
		try {
			client.start();
			await hub.waitForHello(1);
			hub.closeLatest(1001, "agent lost");
			await hub.waitForHello(2); // reconnect backoff ≈1 s (jittered)
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			expect(client.connected).toBe(true);
		} finally {
			client.close();
			hub.stop();
		}
	});

	test("4000 (agent replaced) is fatal: the daemon never reconnects", async () => {
		const hub = startFakeHub();
		const client = startClient(hub.port);
		try {
			client.start();
			await hub.waitForHello(1);
			hub.closeLatest(4000, "agent replaced");
			// The behavior under test is the client's FIRST reconnect backoff
			// (1 s base, ±25 % jitter) — deterministic fake timers cannot drive
			// the live WebSocket retry, so one real backoff window it is.
			await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
			expect(hub.helloCount()).toBe(1);
			expect(client.connected).toBe(false);
		} finally {
			hub.stop();
		}
	});

	// Integration: Bun's real WebSocket heartbeat cannot advance under fake timers.
	test("unacknowledged worker events retry on heartbeats without a reconnect", async () => {
		const hub = startFakeHub();
		const client = startClient(hub.port, 25);
		try {
			client.start();
			await hub.waitForHello(1);
			client.send({ t: "session-event", id: "worker", eventId: "retry-one", kind: "input_required", requestId: "ask" });
			await hub.waitForEvent(2);
			expect(hub.eventCount()).toBeGreaterThanOrEqual(2);
		} finally {
			client.close();
			hub.stop();
		}
	});

});
