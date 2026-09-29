/**
 * Hub API client contract: bearer auth on every request, `{error}` surfaced as
 * {@link HubApiError}, and the exact `POST /api/sessions` body (docs/protocol.md §3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearToken,
	deleteSession,
	getMachineSessions,
	getMachines,
	getMcpServers,
	getNotices,
	HubApiError,
	listMachineDirectories,
	formatShakeSummary,
	listMachineProfiles,
	navigateTree,
	postCompact,
	postExtendedContext,
	postGoal,
	postHandoff,
	postLoop,
	postMcpAdd,
	postMcpEnabled,
	postMcpRemove,
	postMcpTest,
	postPrewalk,
	postRename,
	postRetry,
	postSessionPrompt,
	postShake,
	setModel,
	setToken,
	startSession,
	type Notice,
} from "../src/hub/api";
import type { GoalModeState, SessionRecord, ShakeResult } from "../src/hub/api";

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

	test("getMachineSessions encodes the machine id and unwraps the all-profiles listing", async () => {
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
				{
					path: "/home/dev/.omp/profiles/work/agent/sessions/20260627_b.jsonl",
					id: "resume02bb",
					cwd: "/home/dev/project",
					created: "2026-06-27T13:00:00.000Z",
					modified: "2026-06-27T14:00:00.000Z",
					messageCount: 2,
					firstMessage: "work prompt",
					profile: "work",
				},
			],
			truncated: false,
		};
		stubFetch(() => json({ ok: true, listing }));

		const result = await getMachineSessions("m1");

		expect(calls[0].url).toBe("/api/machines/m1/sessions");
		expect(result).toEqual(listing);
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
		stubFetch(() => json({ path: "/home/dev", parent: "/home", entries: [], truncated: false }));

		await listMachineDirectories("m1");

		expect(calls[0].url).toBe("/api/machines/m1/fs");
	});

	test("postCompact posts the mode and instructions and resolves on ok", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true }));

		await postCompact("s1", { mode: "soft", instructions: "keep the plan" });

		expect(calls[0].url).toBe("/api/sessions/s1/compact");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ mode: "soft", instructions: "keep the plan" });
	});

	test("postCompact sends an empty body object when no options are given", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true }));

		await postCompact("s1");

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
	});

	test("postShake posts the mode and returns the agent's counts", async () => {
		setToken("t0k3n");
		const counts: ShakeResult = { mode: "elide", toolResultsDropped: 4, blocksDropped: 0, tokensFreed: 12_000 };
		stubFetch(() => json({ ok: true, result: counts }));

		const result = await postShake("s1", "elide");

		expect(calls[0].url).toBe("/api/sessions/s1/shake");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ mode: "elide" });
		expect(result).toEqual(counts);
	});

	test("postShake sends an empty body object when no mode is given", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, result: { mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 } }));

		await postShake("s1");

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
	});

	test("postHandoff posts focus instructions and resolves on ok", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true }));

		await postHandoff("s1", "preserve the migration plan");

		expect(calls[0].url).toBe("/api/sessions/s1/handoff");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ instructions: "preserve the migration plan" });
	});

	test("postHandoff sends an empty body object and surfaces 409 as HubApiError", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ error: "Handoff generation is already in progress." }, 409));

		const err = await postHandoff("s1").then(
			() => null,
			(e: unknown) => e,
		);

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
		expect(err).toBeInstanceOf(HubApiError);
		expect((err as HubApiError).status).toBe(409);
	});

	test("formatShakeSummary mirrors the TUI operator lines", () => {
		expect(formatShakeSummary({ mode: "elide", toolResultsDropped: 2, blocksDropped: 1, tokensFreed: 900 })).toBe(
			"Shook 2 tool results + 1 block (~900 tokens freed).",
		);
		expect(formatShakeSummary({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 })).toBe(
			"Shook 1 tool result (~10 tokens freed).",
		);
		expect(formatShakeSummary({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })).toBe(
			"Nothing to shake.",
		);
		expect(formatShakeSummary({ mode: "images", toolResultsDropped: 0, blocksDropped: 0, imagesDropped: 3, tokensFreed: 0 })).toBe(
			"Dropped 3 images from this session.",
		);
		expect(formatShakeSummary({ mode: "images", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })).toBe(
			"No images found in this session.",
		);
		expect(
			formatShakeSummary({ mode: "thinking", toolResultsDropped: 0, blocksDropped: 0, thinkingBlocksDropped: 7, tokensFreed: 2_100 }),
		).toBe("Dropped 7 thinking blocks from this session (~2100 tokens freed).");
		expect(formatShakeSummary({ mode: "thinking", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })).toBe(
			"No thinking blocks found in this session.",
		);
	});

	test("postRetry posts to the retry route", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, started: true }));

		await postRetry("s1");

		expect(calls[0].url).toBe("/api/sessions/s1/retry");
		expect(calls[0].init?.method).toBe("POST");
	});

	test("deleteSession issues DELETE on the session path", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true }));

		await deleteSession("s1");

		expect(calls[0].url).toBe("/api/sessions/s1");
		expect(calls[0].init?.method).toBe("DELETE");
	});

	test("postRetry surfaces the 409 message as HubApiError", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ error: "Wait for the current response to finish or abort it before retrying." }, 409));

		const err = await postRetry("s1").then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(HubApiError);
		expect((err as HubApiError).status).toBe(409);
		expect((err as HubApiError).message).toBe("Wait for the current response to finish or abort it before retrying.");
	});

	test("postRename posts the target name and unwraps the applied one", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, name: "better name", session: { id: "s1", name: "better name" } }));

		const applied = await postRename("s1", "  better name  ");

		expect(applied).toBe("better name");
		expect(calls[0].url).toBe("/api/sessions/s1/rename");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "  better name  " });
	});

	test("postRename surfaces validation errors as HubApiError", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ error: "name is required" }, 400));

		const err = await postRename("s1", "   ").then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(HubApiError);
		expect((err as HubApiError).status).toBe(400);
		expect((err as HubApiError).message).toBe("name is required");
	});

	test("postLoop posts the action with limit and condition and unwraps the status", async () => {
		setToken("t0k3n");
		stubFetch(() =>
			json({
				ok: true,
				loop: {
					state: "running",
					prompt: "fix the failing tests",
					limit: { kind: "iterations", iterations: 10, iterationsLeft: 9 },
					condition: { command: "bun test", until: true },
				},
			}),
		);

		const result = await postLoop("s1", {
			action: "enable",
			prompt: "fix the failing tests",
			limit: { kind: "iterations", iterations: 10 },
			condition: { command: "bun test", until: true },
		});

		expect(calls[0].url).toBe("/api/sessions/s1/loop");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			action: "enable",
			prompt: "fix the failing tests",
			limit: { kind: "iterations", iterations: 10 },
			condition: { command: "bun test", until: true },
		});
		expect(result).toEqual({
			state: "running",
			prompt: "fix the failing tests",
			limit: { kind: "iterations", iterations: 10, iterationsLeft: 9 },
			condition: { command: "bun test", until: true },
		});
	});

	test("postLoop unwraps a null status after disable", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, loop: null }));

		const result = await postLoop("s1", { action: "disable" });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ action: "disable" });
		expect(result).toBeNull();
	});

	test("postGoal posts the action with the objective and unwraps the state", async () => {
		setToken("t0k3n");
		const goal: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: {
				id: "g1",
				objective: "make the tests pass",
				status: "active",
				tokenBudget: 50_000,
				tokensUsed: 1200,
				timeUsedSeconds: 30,
				createdAt: 1,
				updatedAt: 2,
			},
		};
		stubFetch(() => json({ ok: true, goal }));

		const result = await postGoal("s1", { action: "set", objective: "make the tests pass", tokenBudget: 50_000 });

		expect(calls[0].url).toBe("/api/sessions/s1/goal");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			action: "set",
			objective: "make the tests pass",
			tokenBudget: 50_000,
		});
		expect(result).toEqual(goal);
	});

	test("postGoal unwraps a null state after drop and omits unset fields", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, goal: null }));

		const result = await postGoal("s1", { action: "drop" });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ action: "drop" });
		expect(result).toBeNull();
	});

	test("postExtendedContext posts the explicit switch and returns the resulting state", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, extendedContext: true }));

		const result = await postExtendedContext("s1", { enabled: true });

		expect(calls[0].url).toBe("/api/sessions/s1/extended-context");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ enabled: true });
		expect(result).toBe(true);
	});

	test("postExtendedContext sends an empty body for the toggle", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, extendedContext: false }));

		const result = await postExtendedContext("s1");

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
		expect(result).toBe(false);
	});

	test("postPrewalk posts the arm action and unwraps the armed state", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, armed: true, prewalk: { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini", thinkingLevel: null } }));

		const result = await postPrewalk("s1", { action: "arm", target: "@smol" });

		expect(calls[0].url).toBe("/api/sessions/s1/prewalk");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ action: "arm", target: "@smol" });
		expect(result).toEqual({
			armed: true,
			result: undefined,
			prewalk: { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini", thinkingLevel: null },
		});
	});

	test("postPrewalk sends an empty body for the bare state query", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, prewalk: null }));

		const result = await postPrewalk("s1");

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
		expect(result).toEqual({ armed: undefined, result: undefined, prewalk: null });
	});

	test("getMcpServers GETs the mcp path and unwraps the rows", async () => {
		setToken("t0k3n");
		stubFetch(() =>
			json({
				ok: true,
				servers: [
					{ name: "ctx7", scope: "project", type: "http", enabled: true, location: "https://mcp.example.dev/api", envCount: 0 },
					{ name: "localtools", scope: "user", type: "stdio", enabled: false, location: "bun", envCount: 2, health: "disconnected" },
				],
			}),
		);

		const servers = await getMcpServers("s1");

		expect(calls[0].url).toBe("/api/sessions/s1/mcp");
		expect(servers).toHaveLength(2);
		expect(servers[0]).toMatchObject({ name: "ctx7", scope: "project", enabled: true });
	});

	test("postMcpAdd posts only the provided fields and unwraps the placement", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, name: "ctx7", scope: "user" }));

		const added = await postMcpAdd("s1", {
			name: "ctx7",
			scope: "user",
			url: "https://mcp.example.dev/api",
			transport: "sse",
			token: "shh",
		});

		expect(calls[0].url).toBe("/api/sessions/s1/mcp/add");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			name: "ctx7",
			scope: "user",
			url: "https://mcp.example.dev/api",
			transport: "sse",
			token: "shh",
		});
		expect(added).toEqual({ name: "ctx7", scope: "user" });

		await postMcpAdd("s1", { name: "localtools", command: "bun", args: ["run", "mcp"] });
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({ name: "localtools", command: "bun", args: ["run", "mcp"] });
	});

	test("postMcpRemove posts the scoped removal", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true }));

		await postMcpRemove("s1", "ctx7", "project");

		expect(calls[0].url).toBe("/api/sessions/s1/mcp/remove");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "ctx7", scope: "project" });
	});

	test("postMcpEnabled posts the switch and unwraps the touched file", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, name: "ctx7", enabled: false, where: "disabled-list" }));

		const result = await postMcpEnabled("s1", "ctx7", false);

		expect(calls[0].url).toBe("/api/sessions/s1/mcp/enabled");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "ctx7", enabled: false });
		expect(result).toEqual({ name: "ctx7", enabled: false, where: "disabled-list" });
	});

	test("postMcpTest posts the target and unwraps the catalog", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, name: "ctx7", count: 2, tools: [{ name: "resolve" }, { name: "search" }] }));

		const result = await postMcpTest("s1", "ctx7");

		expect(calls[0].url).toBe("/api/sessions/s1/mcp/test");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: "ctx7" });
		expect(result).toEqual({ name: "ctx7", count: 2, tools: [{ name: "resolve" }, { name: "search" }] });
	});

	test("mcp client surfaces agent-reported failures as HubApiError", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ error: 'Server "ctx7" already exists in /home/u/.omp/agent/mcp.json' }, 409));

		const err = await postMcpAdd("s1", { name: "ctx7", command: "bun" }).then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(HubApiError);
		expect((err as HubApiError).message).toContain("already exists");
	});

	test("startSession forwards superagent:true in the POST body", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app", superagent: true });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			machineId: "m1",
			cwd: "/srv/app",
			superagent: true,
		});
	});

	test("startSession omits superagent when unset or false", async () => {
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app", superagent: false });

		expect(Object.keys(JSON.parse(String(calls[0].init?.body)))).toEqual(["machineId", "cwd"]);
	});

	test("startSession forwards the tools whitelist in the POST body", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app", tools: ["bash", "read", "edit", "write"] });

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			machineId: "m1",
			cwd: "/srv/app",
			tools: ["bash", "read", "edit", "write"],
		});
	});

	test("startSession omits an empty tools whitelist", async () => {
		stubFetch(() => json({ session: { id: "s_x" } }, 202));

		await startSession({ machineId: "m1", cwd: "/srv/app", tools: [] });

		expect(Object.keys(JSON.parse(String(calls[0].init?.body)))).toEqual(["machineId", "cwd"]);
	});

	test("postSessionPrompt posts the text and resolves acceptance", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ ok: true, accepted: true }));

		const accepted = await postSessionPrompt("s1", "run the smoke test");

		expect(accepted).toBe(true);
		expect(calls[0].url).toBe("/api/sessions/s1/prompt");
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: "run the smoke test" });
	});

	test("postSessionPrompt surfaces error statuses as HubApiError", async () => {
		setToken("t0k3n");
		stubFetch(() => json({ error: "text is required" }, 400));

		const err = await postSessionPrompt("s1", "   ").then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(HubApiError);
		expect((err as HubApiError).status).toBe(400);
		expect((err as HubApiError).message).toBe("text is required");
	});

	test("getNotices unwraps the notices listing", async () => {
		setToken("t0k3n");
		const notices: Notice[] = [
			{ id: "n_0a0a0a0a0a", message: "deploy done", urgency: "urgent", sessionId: "s1", createdAt: 12 },
			{ id: "n_0b0b0b0b0b", message: "hello", urgency: "info", createdAt: 10 },
		];
		stubFetch(() => json({ notices }));

		const result = await getNotices();

		expect(calls[0].url).toBe("/api/notices");
		expect(result).toEqual(notices);
	});
});
