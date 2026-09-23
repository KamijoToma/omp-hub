/**
 * Relay routing contract (docs/protocol.md §1) exercised over real WebSockets against
 * a hub started in-process on an ephemeral port.
 *
 * Frame assertions are ordering-based (sentinels on the same socket) rather than
 * time-based, so the suite carries no wall-clock latency.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHub, type Hub } from "../src/server";

type Frame =
	| { type: "text"; text: string }
	| { type: "binary"; bytes: Uint8Array }
	| { type: "close"; code: number; reason: string };

/** Queue-backed WebSocket client: frames are taken in arrival order. */
class Wire {
	readonly frames: Frame[] = [];
	#wake: (() => void)[] = [];

	constructor(readonly ws: WebSocket) {
		ws.binaryType = "arraybuffer";
		ws.addEventListener("message", (event: MessageEvent) => {
			const data = event.data as unknown;
			if (typeof data === "string") this.#push({ type: "text", text: data });
			else this.#push({ type: "binary", bytes: new Uint8Array(data as ArrayBuffer) });
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.#push({ type: "close", code: event.code, reason: event.reason });
		});
	}

	#push(frame: Frame): void {
		this.frames.push(frame);
		const wake = this.#wake;
		this.#wake = [];
		for (const resume of wake) resume();
	}

	async #take<T extends Frame>(match: (frame: Frame) => frame is T, what: string): Promise<T> {
		// The deadline is a failure guard only: it is cleared as soon as the frame lands.
		const deadline = Date.now() + 4_000;
		for (;;) {
			const index = this.frames.findIndex(match);
			if (index !== -1) return this.frames.splice(index, 1)[0] as T;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`timeout waiting for ${what}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, remaining);
			this.#wake.push(() => {
				clearTimeout(timer);
				resolve();
			});
			await promise;
		}
	}

	text(): Promise<string> {
		return this.#take((f): f is Extract<Frame, { type: "text" }> => f.type === "text", "TEXT frame").then((f) => f.text);
	}

	json(): Promise<Record<string, unknown>> {
		return this.text().then((raw) => JSON.parse(raw) as Record<string, unknown>);
	}

	binary(): Promise<Uint8Array> {
		return this.#take((f): f is Extract<Frame, { type: "binary" }> => f.type === "binary", "binary frame").then(
			(f) => f.bytes,
		);
	}

	closed(): Promise<{ code: number; reason: string }> {
		return this.#take((f): f is Extract<Frame, { type: "close" }> => f.type === "close", "close").then((f) => ({
			code: f.code,
			reason: f.reason,
		}));
	}

	/** Resolves once the client socket is open (immediately when it already is). */
	opened(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.ws.addEventListener("open", () => resolve(), { once: true });
		this.ws.addEventListener("close", (event: CloseEvent) => reject(new Error(`closed (${event.code}) before open`)), {
			once: true,
		});
		return promise;
	}

	close(): void {
		this.ws.close();
	}
}

let hub: Hub;
let wsBase: string;
let httpBase: string;

beforeAll(() => {
	hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	wsBase = hub.url.replace(/^http/, "ws");
	httpBase = hub.url;
});

afterAll(() => {
	hub.stop();
});

function connect(path: string): Wire {
	return new Wire(new WebSocket(`${wsBase}${path}`));
}

/** `[4B uint32 BE peerId][payload]` */
function envelope(peerId: number, payload: number[]): Uint8Array {
	const frame = new Uint8Array(4 + payload.length);
	new DataView(frame.buffer).setUint32(0, peerId, false);
	frame.set(payload, 4);
	return frame;
}

function peerIdOf(frame: Uint8Array): number {
	return new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
}

describe("relay", () => {
	test("host creates the room; joins and leaves are announced to the host", async () => {
		const host = connect("/r/relaytestaaa?role=host");
		const first = connect("/r/relaytestaaa?role=guest");
		expect(await host.json()).toEqual({ t: "peer-joined", peer: 1 });

		const second = connect("/r/relaytestaaa?role=guest");
		expect(await host.json()).toEqual({ t: "peer-joined", peer: 2 });

		first.close();
		expect(await host.json()).toEqual({ t: "peer-left", peer: 1 });

		second.close();
		host.close();
	});

	test("a second host is rejected with 4009 without tearing down the live room", async () => {
		const host = connect("/r/relaytestbbb?role=host");
		const intruder = connect("/r/relaytestbbb?role=host");
		expect(await intruder.closed()).toMatchObject({ code: 4009 });

		// The room survived the rejected upgrade: a guest still joins it.
		const guest = connect("/r/relaytestbbb?role=guest");
		expect(await host.json()).toEqual({ t: "peer-joined", peer: 1 });

		guest.close();
		host.close();
	});

	test("a guest without a live room is closed with 4004", async () => {
		const guest = connect("/r/relaytestccc?role=guest");
		expect(await guest.closed()).toMatchObject({ code: 4004 });
	});

	test("host peerId 0 broadcasts unchanged to every guest, peerId N targets one", async () => {
		const host = connect("/r/relaytestddd?role=host");
		const first = connect("/r/relaytestddd?role=guest");
		const second = connect("/r/relaytestddd?role=guest");
		await host.opened();
		await host.json();
		await host.json();

		const broadcast = envelope(0, [7, 7, 7]);
		host.ws.send(broadcast);
		expect(await first.binary()).toEqual(broadcast);
		expect(await second.binary()).toEqual(broadcast);

		// Guest 1 receives a sentinel sent *after* the targeted frame: seeing the sentinel
		// (and nothing else) proves the targeted frame was never relayed to it.
		host.ws.send(envelope(2, [1, 2, 3]));
		expect(await second.binary()).toEqual(envelope(2, [1, 2, 3]));
		host.ws.send(envelope(1, [9]));
		expect(await first.binary()).toEqual(envelope(1, [9]));
		expect(first.frames).toEqual([]);

		host.close();
		first.close();
		second.close();
	});

	test("guest frames reach only the host with the sender's peerId", async () => {
		const host = connect("/r/relaytesteee?role=host");
		const first = connect("/r/relaytesteee?role=guest");
		const second = connect("/r/relaytesteee?role=guest");
		await second.opened();
		await host.json();
		await host.json();

		second.ws.send(envelope(0, [42, 43]));
		const delivered = await host.binary();
		expect(peerIdOf(delivered)).toBe(2);
		expect([...delivered.subarray(4)]).toEqual([42, 43]);
		// The host has handled the guest frame, so the other guest provably saw nothing.
		expect(first.frames).toEqual([]);

		host.close();
		first.close();
		second.close();
	});

	test("host close sends room-closed then 4001 to every guest", async () => {
		const host = connect("/r/relaytestfff?role=host");
		const first = connect("/r/relaytestfff?role=guest");
		const second = connect("/r/relaytestfff?role=guest");
		await host.json();
		await host.json();

		host.close();
		for (const guest of [first, second]) {
			expect(await guest.json()).toEqual({ t: "room-closed" });
			expect(await guest.closed()).toMatchObject({ code: 4001 });
		}
	});

	test("malformed room paths and roles are rejected with 404", async () => {
		for (const path of ["/r/short?role=host", "/r/relaytestggg", "/r/relaytestggg?role=spectator", "/r/"]) {
			const response = await fetch(`${httpBase}${path}`);
			expect(response.status).toBe(404);
		}
	});

	test("/healthz answers ok without auth", async () => {
		const response = await fetch(`${httpBase}/healthz`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});
});
