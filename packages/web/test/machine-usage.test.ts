/**
 * Machine usage client (docs/protocol.md §3 usage relay) and the §5
 * `/usage/<machineId>` route: exact relay URLs, bearer auth, error surfacing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearToken, errorText, getMachineUsage, HubApiError, setToken, syncMachineUsage } from "../src/hub/api";
import { parseRoute } from "../src/hub/router";

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

function stubFetch(reply: () => Response | Promise<Response>): void {
	const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init });
		return reply();
	};
	globalThis.fetch = stub as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
	calls = [];
	setToken("t");
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearToken();
});

describe("usage route", () => {
	test("parses /usage/<machineId>", () => {
		expect(parseRoute("/usage/m-1")).toEqual({ kind: "usage", machineId: "m-1" });
		expect(parseRoute("/usage/m-1/")).toEqual({ kind: "usage", machineId: "m-1" });
		expect(parseRoute("/usage/m%2Fx")).toEqual({ kind: "usage", machineId: "m/x" });
	});

	test("leaves near-misses unknown", () => {
		expect(parseRoute("/usage").kind).toBe("unknown");
		expect(parseRoute("/usage/").kind).toBe("unknown");
		expect(parseRoute("/usage/m-1/extra").kind).toBe("unknown");
	});
});

describe("usage api", () => {
	test("getMachineUsage relays the stats path with the range and bearer token", async () => {
		const payload = { overall: { totalRequests: 4 }, byModel: [], timeSeries: [] };
		stubFetch(() => json(payload));

		const stats = await getMachineUsage("m-1", "24h");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/api/machines/m-1/usage/api/stats?range=24h");
		expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer t");
		expect(stats.overall.totalRequests).toBe(4);
	});

	test("syncMachineUsage posts to the relayed sync endpoint", async () => {
		stubFetch(() => json({ processed: 2, files: 1, totalMessages: 9 }));

		const result = await syncMachineUsage("m-2");

		expect(calls[0]).toMatchObject({ url: "/api/machines/m-2/usage/api/sync", init: { method: "POST" } });
		expect(result).toEqual({ processed: 2, files: 1, totalMessages: 9 });
	});

	test("surfaces relay failures as HubApiError", async () => {
		stubFetch(() => json({ error: "machine offline" }, 502));

		const err = await getMachineUsage("m-3", "all").then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(HubApiError);
		expect(errorText(err)).toBe("machine offline");
	});
});
