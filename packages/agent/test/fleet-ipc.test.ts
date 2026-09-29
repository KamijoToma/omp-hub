/**
 * Supervisor fleet IPC (protocol 0.8.0 §4): a superagent child's `fleet-req`
 * reaches the configured proxy handler and its `fleet-res` is written back to
 * the child's stdin; non-superagent children get the refusal; a throwing
 * handler still answers exactly once (`ok:false`).
 */

import { expect, test } from "bun:test";
import { createLogger } from "../src/log";
import { type SessionReadyPayload, Supervisor } from "../src/supervisor";

const FIXTURE = new URL("./fixtures/fleet-child.ts", import.meta.url).pathname;

function fixtureSupervisor(fleet?: NonNullable<ConstructorParameters<typeof Supervisor>[2]>["fleet"]) {
	const ready = Promise.withResolvers<SessionReadyPayload>();
	const supervisor = new Supervisor(
		{
			onReady: (_id, payload) => ready.resolve(payload),
			onError: () => {},
			onExit: () => {},
		},
		createLogger("fleet-test"),
		{ hostEntry: FIXTURE, fleet },
	);
	return { supervisor, ready: ready.promise };
}

test("superagent child's fleet-req is proxied and answered with the handler's payload", async () => {
	const calls: Array<{ reqId: string; method: string; path: string; body?: unknown }> = [];
	const { supervisor, ready } = fixtureSupervisor(async req => {
		calls.push(req);
		return { ok: true, status: 200, body: { machines: [{ id: "m1" }] } };
	});
	await supervisor.spawn({
		id: "s_fleet_ok",
		cwd: import.meta.dir,
		superagent: true,
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	await ready;

	const ack = await supervisor.cmd("s_fleet_ok", {
		reqId: "c_fleet1",
		cmd: "emit-fleet-req",
		method: "GET",
		path: "/api/machines",
	});
	expect(ack.ok).toBe(true);
	expect(calls).toEqual([{ reqId: "fleet_c_fleet1", method: "GET", path: "/api/machines" }]);
	expect(ack).toEqual({
		ok: true,
		data: { t: "fleet-res", reqId: "fleet_c_fleet1", ok: true, status: 200, body: { machines: [{ id: "m1" }] } },
	});

	await supervisor.stopAll("fleet ok test done");
});

test("non-superagent child's fleet-req gets the refusal", async () => {
	const { supervisor, ready } = fixtureSupervisor(async () => {
		throw new Error("handler must never run for a non-superagent child");
	});
	await supervisor.spawn({ id: "s_fleet_no", cwd: import.meta.dir, relayUrl: "ws://127.0.0.1:1", webUrl: "" });
	await ready;

	const ack = await supervisor.cmd("s_fleet_no", {
		reqId: "c_fleet2",
		cmd: "emit-fleet-req",
		method: "GET",
		path: "/api/sessions",
	});
	expect(ack).toEqual({
		ok: true,
		data: { t: "fleet-res", reqId: "fleet_c_fleet2", ok: false, error: "fleet: not a superagent session" },
	});

	await supervisor.stopAll("fleet refusal test done");
});

test("a throwing fleet handler answers ok:false exactly once", async () => {
	const { supervisor, ready } = fixtureSupervisor(async () => {
		throw new Error("hub exploded");
	});
	await supervisor.spawn({
		id: "s_fleet_throw",
		cwd: import.meta.dir,
		superagent: true,
		relayUrl: "ws://127.0.0.1:1",
		webUrl: "",
	});
	await ready;

	const ack = await supervisor.cmd("s_fleet_throw", {
		reqId: "c_fleet3",
		cmd: "emit-fleet-req",
		method: "POST",
		path: "/api/notices",
		body: { message: "hi" },
	});
	expect(ack).toEqual({
		ok: true,
		data: { t: "fleet-res", reqId: "fleet_c_fleet3", ok: false, error: "hub exploded" },
	});

	await supervisor.stopAll("fleet throw test done");
});
