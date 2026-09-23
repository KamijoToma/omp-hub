/**
 * Hub API client contract: bearer auth on every request, `{error}` surfaced as
 * {@link HubApiError}, and the exact `POST /api/sessions` body (docs/protocol.md §3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearToken, getMachines, HubApiError, setToken, startSession } from "../src/hub/api";
import type { SessionRecord } from "../src/hub/api";

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

function stubFetch(reply: () => Response | Promise<Response>): void {
	const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init });
		return await reply();
	};
	globalThis.fetch = stub as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
	calls = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
	clearToken();
});

describe("hub api", () => {
	test("sends the stored token as a bearer authorization header", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ machines: [] }));

		await getMachines();

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("/api/machines");
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer t0k3n");
	});

	test("throws HubApiError carrying the server error field", async () => {
		setToken("stale");
		stubFetch(() => json({ error: "unauthorized" }, 401));

		const err = await getMachines().then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(HubApiError);
		expect((err as HubApiError).status).toBe(401);
		expect((err as HubApiError).message).toBe("unauthorized");
	});

	test("startSession posts the protocol body and unwraps the session", async () => {
		setToken("t0k3n");
		const session: SessionRecord = {
			id: "s_abc1234567",
			machineId: "m1",
			machineName: "box",
			cwd: "/srv/app",
			name: "app",
			status: "starting",
			startedAt: 1,
		};
		stubFetch(() => json({ session }, 202));

		const result = await startSession({ machineId: "m1", cwd: "/srv/app", name: "app", prompt: "fix it" });

		expect(result).toEqual(session);
		expect(calls[0].url).toBe("/api/sessions");
		expect(calls[0].init?.method).toBe("POST");
		expect(new Headers(calls[0].init?.headers).get("Content-Type")).toBe("application/json");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			machineId: "m1",
			cwd: "/srv/app",
			name: "app",
			prompt: "fix it",
		});
	});

	test("startSession omits unset optional fields", async () => {
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app" });

		expect(Object.keys(JSON.parse(String(calls[0].init?.body)))).toEqual(["machineId", "cwd"]);
	});
});
