import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHub, type Hub } from "../src/server";

let hub: Hub;
let origin: string;
let socketOrigin: string;

beforeAll(() => {
	hub = startHub({ port: 0, hostname: "127.0.0.1", token: "t", publicUrl: "" });
	origin = hub.url;
	socketOrigin = origin.replace(/^http/, "ws");
});
afterAll(() => hub.stop());

function nextFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const onMessage = (event: MessageEvent) => {
		const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
		if (frame.t !== type) return;
		ws.removeEventListener("message", onMessage);
		ws.removeEventListener("close", onClose);
		resolve(frame);
	};
	const onClose = () => {
		ws.removeEventListener("message", onMessage);
		reject(new Error(`socket closed before ${type}`));
	};
	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", onClose, { once: true });
	return promise;
}

async function connect(machineId: string): Promise<WebSocket> {
	const ws = new WebSocket(`${socketOrigin}/agent`, { headers: { authorization: "Bearer t" } });
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	ws.addEventListener("open", () => resolve(), { once: true });
	ws.addEventListener("error", () => reject(new Error("agent connection failed")), { once: true });
	await promise;
	const welcomed = nextFrame(ws, "welcome");
	ws.send(JSON.stringify({ t: "hello", machineId, name: machineId, version: "test" }));
	await welcomed;
	return ws;
}

function request(path: string, authenticated = true): Promise<Response> {
	return fetch(`${origin}${path}`, { headers: authenticated ? { authorization: "Bearer t" } : {} });
}

test("subscription usage authenticates before dispatch and rejects missing machines", async () => {
	expect((await request("/api/machines/unknown/subscriptions", false)).status).toBe(401);
	const missing = await request("/api/machines/unknown/subscriptions");
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ error: "machine not found" });
});

test("rejects all/invalid/duplicate profiles rather than fetching the daemon's default", async () => {
	const ws = await connect("subscription-validate");
	try {
		for (const profile of ["all", "", "../private", "CON", "work."]) {
			const result = await request(`/api/machines/subscription-validate/subscriptions?profile=${encodeURIComponent(profile)}`);
			expect(result.status).toBe(400);
		}
		expect((await request("/api/machines/subscription-validate/subscriptions?profile=default&profile=work")).status).toBe(400);
	} finally {
		ws.close();
	}
});

test("unsupported older agents do not fabricate default quota for named profiles", async () => {
	const ws = await connect("subscription-old-agent");
	try {
		const next = nextFrame(ws, "cmd");
		const pending = request("/api/machines/subscription-old-agent/subscriptions?profile=work");
		const frame = await next;
		ws.send(JSON.stringify({ t: "cmd-result", reqId: frame.reqId, ok: false, error: "unknown machine command: get-subscriptions" }));
		const result = await pending;
		expect(result.status).toBe(501);
		expect(await result.json()).toEqual({ error: "agent does not support subscription usage" });
	} finally {
		ws.close();
	}
});

test("an in-flight quota request fails when its agent disconnects", async () => {
	const ws = await connect("subscription-disconnect");
	const next = nextFrame(ws, "cmd");
	const pending = request("/api/machines/subscription-disconnect/subscriptions?profile=default");
	const frame = await next;
	expect(frame).toMatchObject({ cmd: "get-subscriptions", profile: "default" });
	ws.close();
	const result = await pending;
	expect(result.status).toBe(502);
	expect(await result.json()).toEqual({ error: "agent disconnected" });
});
