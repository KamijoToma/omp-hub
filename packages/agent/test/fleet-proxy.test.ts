/**
 * Fleet proxy unit tests (protocol 0.8.0 "Fleet proxy"): whitelist matrix,
 * superagent stripping, scheme conversion, and transport-failure mapping.
 * All network access is a stub fetch — no hub required.
 */

import { expect, test } from "bun:test";
import { handleFleetRequest, hubHttpBase, isAllowedFleetPath, stripFleetSuperagent } from "../src/fleet-proxy";

test("whitelist allows every §4 route", () => {
	const allowed: Array<[string, string]> = [
		["GET", "/api/machines"],
		["GET", "/api/sessions"],
		["GET", "/api/sessions/s_abc123"],
		["POST", "/api/sessions"],
		["POST", "/api/sessions/s_abc123/stop"],
		["POST", "/api/sessions/s_abc123/prompt"],
		["POST", "/api/notices"],
		// Query strings are ignored: the pathname is what must match.
		["GET", "/api/sessions?status=live"],
		["GET", "/api/machines?verbose=1"],
		["POST", "/api/notices?dry=1"],
	];
	for (const [method, path] of allowed) {
		expect(isAllowedFleetPath(method, path)).toBe(true);
	}
});

test("whitelist denies representative non-whitelisted requests", () => {
	const denied: Array<[string, string]> = [
		["DELETE", "/api/sessions/s_abc123"],
		["PUT", "/api/machines"],
		["POST", "/api/hub/restart"],
		["GET", "/api/hub/restart"],
		["GET", "/api/sessions/s_abc123/files"],
		["POST", "/api/sessions/s_abc123/files"],
		// Trailing slash: POST /api/sessions must match exactly.
		["POST", "/api/sessions/"],
		["POST", "/api/machines"],
		["GET", "/api/notices"],
		["GET", "/api/sessions/s_a/prompt"], // prompt is POST-only
		["POST", "/api/sessions/s_a/stop/extra"],
		["GET", "/other"],
		["GET", "/api"],
	];
	for (const [method, path] of denied) {
		expect(isAllowedFleetPath(method, path), `${method} ${path}`).toBe(false);
	}
});

test("stripFleetSuperagent rewrites the recursion flag on copies only", () => {
	const body = { machineId: "m1", cwd: "/tmp", superagent: true };
	// The flag is deleted, so the hub sees a plain session start.
	expect(stripFleetSuperagent(body)).toEqual({ machineId: "m1", cwd: "/tmp" });
	// The caller's object is never mutated (shallow copy).
	expect(body.superagent).toBe(true);
	// Non-objects pass through untouched.
	expect(stripFleetSuperagent(undefined)).toBe(undefined);
	expect(stripFleetSuperagent("x")).toBe("x");
	expect(stripFleetSuperagent(null)).toBe(null);
	// A body without the flag is an equal copy.
	expect(stripFleetSuperagent({ a: 1 })).toEqual({ a: 1 });
});

test("hubHttpBase upgrades ws schemes and trims trailing slashes", () => {
	expect(hubHttpBase("ws://localhost:8787")).toBe("http://localhost:8787");
	expect(hubHttpBase("wss://hub.example.com")).toBe("https://hub.example.com");
	expect(hubHttpBase("http://localhost:8787/")).toBe("http://localhost:8787");
	expect(hubHttpBase("https://hub.example.com/")).toBe("https://hub.example.com");
});

test("handleFleetRequest denies disallowed paths before any network call", async () => {
	let fetched = 0;
	const logs: string[] = [];
	const result = await handleFleetRequest(
		{ method: "POST", path: "/api/hub/restart" },
		{
			hubBase: "http://hub",
			token: "t",
			log: message => logs.push(message),
			fetch: async () => {
				fetched += 1;
				throw new Error("must not fetch");
			},
		},
	);
	expect(result).toEqual({ ok: false, error: "fleet: path not allowed" });
	expect(fetched).toBe(0);
	expect(logs).toEqual(["fleet POST /api/hub/restart -> fleet: path not allowed"]);
});

test("handleFleetRequest strips superagent from POST /api/sessions bodies and proxies with the token", async () => {
	let captured: { url: string; init: RequestInit } | undefined;
	const result = await handleFleetRequest(
		{ method: "POST", path: "/api/sessions", body: { machineId: "m1", cwd: "/tmp", superagent: true } },
		{
			hubBase: "http://hub:8787",
			token: "sekrit",
			log: () => {},
			fetch: async (url, init) => {
				captured = { url: String(url), init: init ?? {} };
				return new Response(JSON.stringify({ id: "s_new" }), { status: 201 });
			},
		},
	);
	expect(captured?.url).toBe("http://hub:8787/api/sessions");
	expect(captured?.init.method).toBe("POST");
	expect(JSON.parse(String(captured?.init.body))).toEqual({ machineId: "m1", cwd: "/tmp" });
	expect(new Headers(captured?.init.headers).get("authorization")).toBe("Bearer sekrit");
	expect(result).toEqual({ ok: true, status: 201, body: { id: "s_new" } });
});

test("handleFleetRequest leaves non-session-start bodies untouched and replays HTTP error statuses", async () => {
	let capturedBody: string | undefined;
	const result = await handleFleetRequest(
		{ method: "POST", path: "/api/sessions/s_1/stop", body: { reason: "done", superagent: true } },
		{
			hubBase: "http://hub",
			token: "t",
			log: () => {},
			fetch: async (_url, init) => {
				capturedBody = String(init?.body);
				return new Response(JSON.stringify({ error: "unknown session" }), { status: 404 });
			},
		},
	);
	// Only POST /api/sessions bodies are rewritten (defense stays narrow).
	expect(JSON.parse(capturedBody ?? "{}")).toEqual({ reason: "done", superagent: true });
	// HTTP error statuses replay as ok:true + status; the tool layer converts.
	expect(result).toEqual({ ok: true, status: 404, body: { error: "unknown session" } });
});

test("handleFleetRequest maps transport failures to ok:false", async () => {
	const result = await handleFleetRequest(
		{ method: "GET", path: "/api/machines" },
		{
			hubBase: "http://hub",
			token: "t",
			log: () => {},
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		},
	);
	expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
});
