/**
 * Panel restart client (docs/protocol.md §3 `POST /api/machines/:id/restart-daemon`):
 * exact URL, bearer auth, and refusal surfacing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearToken, errorText, HubApiError, restartDaemon, setToken } from "../src/hub/api";

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

describe("restartDaemon api", () => {
	test("posts to the machine restart endpoint with the bearer token", async () => {
		const machine = { machineId: "m-1", name: "dev", connected: true, connectedAt: 1, sessionCount: 2, restarting: true };
		stubFetch(() => json({ ok: true, machine }));

		const reply = await restartDaemon("m-1");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/api/machines/m-1/restart-daemon");
		expect(calls[0]!.init?.method).toBe("POST");
		expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer t");
		expect(reply.restarting).toBe(true);
	});

	test("encodes the machine id", async () => {
		stubFetch(() => json({ ok: true, machine: { machineId: "m/x", name: "x", connected: true, connectedAt: 1, sessionCount: 0 } }));
		await restartDaemon("m/x");
		expect(calls[0]!.url).toBe("/api/machines/m%2Fx/restart-daemon");
	});

	test("surfaces refusals as HubApiError with the hub's message", async () => {
		stubFetch(() => json({ error: "daemon restart already in progress" }, 409));

		let caught: unknown;
		try {
			await restartDaemon("m-1");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(HubApiError);
		expect((caught as HubApiError).status).toBe(409);
		expect(errorText(caught)).toBe("daemon restart already in progress");
	});
});
