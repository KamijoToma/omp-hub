/**
 * Hub API client contract: bearer auth on every request, `{error}` surfaced as
 * {@link HubApiError}, and the exact `POST /api/sessions` body (docs/protocol.md §3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearToken,
	getMachineSessions,
	getMachines,
	HubApiError,
	listMachineDirectories,
	listMachineProfiles,
	navigateTree,
	setModel,
	setToken,
	startSession,
} from "../src/hub/api";
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

	test("startSession forwards the resume sessionFile", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app", sessionFile: "/home/dev/.omp/sessions/a.jsonl" });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			machineId: "m1",
			cwd: "/srv/app",
			sessionFile: "/home/dev/.omp/sessions/a.jsonl",
		});
	});

	test("getMachineSessions encodes the machine id and cwd scope and unwraps the listing", async () => {
		setToken("t0k3n");
		const listing = {
			sessions: [
				{
					path: "/home/dev/.omp/sessions/20260627_a.jsonl",
					id: "resume01aa",
					cwd: "/home/dev/project",
					created: "2026-06-27T00:00:00.000Z",
					modified: "2026-06-27T12:00:00.000Z",
					messageCount: 2,
					firstMessage: "first prompt",
				},
			],
			truncated: false,
		};
		stubFetch(() => json({ ok: true, listing }));

		const result = await getMachineSessions("m1", "/home/dev projects");

		expect(calls[0].url).toBe(`/api/machines/m1/sessions?cwd=${encodeURIComponent("/home/dev projects")}`);
		expect(result).toEqual(listing);
	});

	test("getMachineSessions omits the query for the all-projects listing", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, listing: { sessions: [], truncated: false } }));

		await getMachineSessions("m1");

		expect(calls[0].url).toBe("/api/machines/m1/sessions");
	});

	test("startSession omits unset optional fields", async () => {
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app" });

		expect(Object.keys(JSON.parse(String(calls[0].init?.body)))).toEqual(["machineId", "cwd"]);
	});

	test("startSession forwards the selected omp profile", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app", profile: "work" });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			machineId: "m1",
			cwd: "/srv/app",
			profile: "work",
		});
	});

	test("listMachineProfiles unwraps the machine's profile list", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, profiles: ["personal", "work"] }));

		const profiles = await listMachineProfiles("m1");

		expect(calls[0].url).toBe("/api/machines/m1/profiles");
		expect(profiles).toEqual(["personal", "work"]);
	});

	test("setModel posts provider/modelId and unwraps the role reply", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, switched: true, role: "default", thinkingLevel: null }));

		const result = await setModel("s1", "openai", "gpt-5");

		expect(calls[0].url).toBe("/api/sessions/s1/model");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ provider: "openai", modelId: "gpt-5" });
		expect(result).toEqual({ switched: true, role: "default", thinkingLevel: null });
	});

	test("setModel forwards the thinking level and unwraps the effective one", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, switched: true, role: "default", thinkingLevel: "high" }));

		const result = await setModel("s1", "openai", "gpt-5", { level: "high" });

		expect(calls[0].url).toBe("/api/sessions/s1/model");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ provider: "openai", modelId: "gpt-5", level: "high" });
		expect(result).toEqual({ switched: true, role: "default", thinkingLevel: "high" });
	});

	test("setModel forwards role and persist options", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, switched: true, role: "smol", thinkingLevel: null }));

		const result = await setModel("s1", "openai", "gpt-5", { role: "smol", persist: false });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			provider: "openai",
			modelId: "gpt-5",
			role: "smol",
			persist: false,
		});
		expect(result).toEqual({ switched: true, role: "smol", thinkingLevel: null });
	});

	test("navigateTree posts the target entry and unwraps the move result", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, cancelled: false, aborted: false, editorText: "fix it", leafId: "e_9" }));

		const result = await navigateTree("s1", "e_5");

		expect(calls[0].url).toBe("/api/sessions/s1/tree");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ entryId: "e_5" });
		expect(result).toEqual({ cancelled: false, aborted: false, editorText: "fix it", leafId: "e_9" });
	});

	test("navigateTree forwards the summarize option", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, cancelled: false, aborted: false, editorText: null, leafId: "e_2" }));

		await navigateTree("s1", "e_5", { summarize: true });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ entryId: "e_5", summarize: true });
	});

	test("listMachineDirectories encodes the machine id and path and unwraps the listing", async () => {
		setToken("t0k3n");
		const listing = {
			path: "/home/dev",
			parent: "/home",
			entries: [{ name: "omp-hub", path: "/home/dev/omp-hub" }],
			truncated: false,
		};
		stubFetch(() => json({ ok: true, listing }));

		const result = await listMachineDirectories("m1", "/home/dev projects");

		expect(calls[0].url).toBe(`/api/machines/m1/fs?path=${encodeURIComponent("/home/dev projects")}`);
		expect(result).toEqual(listing);
	});

	test("listMachineDirectories omits the query for the machine home", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, listing: { path: "/home/dev", parent: "/home", entries: [], truncated: false } }));

		await listMachineDirectories("m1");

		expect(calls[0].url).toBe("/api/machines/m1/fs");
	});
});
