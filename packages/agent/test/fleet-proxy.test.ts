import { expect, test } from "bun:test";
import { handleFleetRequest, isAllowedFleetPath } from "../src/fleet-proxy";

test("only fleet namespace routes can cross the daemon boundary", () => {
	for (const [method, path] of [
		["GET", "/api/fleet/machines"], ["GET", "/api/fleet/sessions"], ["GET", "/api/fleet/events"],
		["GET", "/api/fleet/sessions/s_worker"], ["GET", "/api/fleet/sessions/s_worker/input"],
		["GET", "/api/fleet/sessions/s_worker/messages?cursor=a1&limit=20"],
		["GET", "/api/fleet/sessions/s_worker/search?query=git+merge&from=2026-09-30T12%3A00%3A00Z&to=2026-10-01T12%3A00%3A00Z&cursor=a1&limit=20"],
		["GET", "/api/fleet/sessions/s_worker/search?to=2026-09-30T12%3A00%3A00Z"],
		["GET", "/api/fleet/sessions/s_worker/search?query=merge&fields=%5B%22toolCall.arguments.command%22%5D"],
		["POST", "/api/fleet/search"],
		["POST", "/api/fleet/sessions/s_worker/message-context"],
		["POST", "/api/fleet/sessions"], ["POST", "/api/fleet/notices"],
		...["claim", "stop", "message", "interrupt", "watch", "input"].map(action => ["POST", `/api/fleet/sessions/s_worker/${action}`]),
		["POST", "/api/fleet/events/e_123/ack"],
	]) expect(isAllowedFleetPath(method, path), path).toBe(true);
	for (const [method, path] of [
		["GET", "/api/sessions"], ["POST", "/api/sessions/s_worker/prompt"],
		["GET", "/api/fleet/sessions/s_worker/messages?ownerId=s_other"],
		["GET", "/api/fleet/sessions/s_worker/search?ownerId=s_other"],
		["GET", "/api/fleet/sessions/s_worker/search?sessionFile=%2Ftmp%2Fprivate.jsonl"],
		["GET", "/api/fleet/sessions/s_worker/search?namespaceId=other"],
		["GET", "/api/fleet/search"],
		["POST", "/api/fleet/search?namespaceId=other"],
		["GET", "/api/fleet/sessions/s_worker/message-context"],
		["POST", "/api/fleet/sessions/s_worker/message-context?messageId=private"],
		["GET", "/api/fleet/sessions/s_worker/messages?query=private"],
		["POST", "/api/fleet/sessions/s_worker/search?query=test"],
		["GET", "/api/fleet/machines?namespaceId=other"],
		["GET", "//evil.invalid/api/fleet/sessions"],
		["GET", "/api/fleet/sessions/s_worker%2Fsecret"],
		["GET", "/api/fleet/sessions/s_worker/files"],
		["POST", "/api/fleet/sessions/s_worker/prompt"],
		["POST", "/api/fleet/sessions/s_worker/stop/"],
		["POST", "/api/fleet/sessions/s_worker/messages"],
		["DELETE", "/api/fleet/sessions/s_worker"],
	]) expect(isAllowedFleetPath(method, path), path).toBe(false);
});

test("proxy derives owner from supervisor and removes caller-supplied identities", async () => {
	const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
	const deps = {
		hubBase: "https://hub", token: "secret", ownerId: "s_actual", log: () => {},
		fetch: async (url: string, init?: RequestInit) => {
			calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		},
	};
	await handleFleetRequest({
		method: "POST", path: "/api/fleet/sessions",
		body: { machineId: "m1", cwd: "/work", forkFrom: "s_source", ownerId: "s_other", namespaceId: "other", superagent: true, tools: ["bash"] },
	}, deps);
	await handleFleetRequest({
		method: "POST", path: "/api/fleet/sessions/s_worker/message",
		body: { mode: "steer", text: "help", ownerId: "s_other", namespaceId: "other" },
	}, deps);
	await handleFleetRequest({
		method: "GET", path: "/api/fleet/sessions/s_worker/search?query=merge",
		body: { ownerId: "s_other", namespaceId: "other", sessionFile: "/private/history.jsonl" },
	}, deps);
	await handleFleetRequest({
		method: "POST", path: "/api/fleet/search",
		body: { query: "merge", roles: ["assistant"], fields: ["toolCall.arguments.command"],
			sessionIds: ["s_worker"], ownerId: "s_other", namespaceId: "other", sessionFile: "/private/history.jsonl" },
	}, deps);
	await handleFleetRequest({
		method: "POST", path: "/api/fleet/sessions/s_worker/message-context",
		body: { messageId: "command", before: 0, after: 0, toolCallId: "tc1", contentCursor: "content",
			ownerId: "s_other", namespaceId: "other", path: "/private/history.jsonl" },
	}, deps);
	expect(calls.map(call => call.body)).toEqual([
		{ machineId: "m1", cwd: "/work", forkFrom: "s_source" }, { mode: "steer", text: "help" }, null,
		{ query: "merge", roles: ["assistant"], fields: ["toolCall.arguments.command"], sessionIds: ["s_worker"] },
		{ messageId: "command", before: 0, after: 0, toolCallId: "tc1", contentCursor: "content" },
	]);
	expect(calls.every(call => call.headers.get("X-Fleet-Owner") === "s_actual")).toBe(true);
	expect(calls.every(call => call.headers.get("authorization") === "Bearer secret")).toBe(true);
	expect(calls[0]?.url).toBe("https://hub/api/fleet/sessions");
	expect(calls[2]?.url).toBe("https://hub/api/fleet/sessions/s_worker/search?query=merge");
});

test("refused routes do not fetch; HTTP errors remain visible to tools", async () => {
	let count = 0;
	const deps = {
		hubBase: "http://hub", token: "token", ownerId: "s_owner", log: () => {},
		fetch: async () => { count++; return new Response(JSON.stringify({ error: "not controller" }), { status: 403 }); },
	};
	expect(await handleFleetRequest({ method: "GET", path: "/api/sessions" }, deps)).toEqual({
		ok: false, error: "fleet: path not allowed",
	});
	expect(count).toBe(0);
	expect(await handleFleetRequest({ method: "POST", path: "/api/fleet/sessions/s_worker/stop" }, deps)).toEqual({
		ok: true, status: 403, body: { error: "not controller" },
	});
});
