/**
 * Fleet tools for superagent sessions (protocol 0.8.0).
 *
 * One tool per whitelisted hub route, all funneled through the fleet client's
 * `request` so no hub token ever reaches the child. Tool errors are thrown
 * `Error`s -- the SDK renders them as failed tool calls with the message.
 */

import { type } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { FleetResult } from "./fleet-client";

type FleetRequest = (method: string, path: string, body?: unknown) => Promise<FleetResult>;

/** Tool call errors: `fleet: <cause>` so the model can tell them apart. */
function assertFetched(result: FleetResult): { status: number; body: unknown } {
	if (!result.ok) throw new Error(`fleet: ${result.error}`);
	if (result.status >= 400) {
		const cause = (result.body as { error?: unknown } | undefined)?.error ?? result.body;
		throw new Error(`fleet: HTTP ${result.status} ${JSON.stringify(cause)}`);
	}
	return { status: result.status, body: result.body };
}

/** Tool result body: the hub's JSON payload, pretty-printed for the transcript. */
function textResult(body: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify(body ?? null, null, 2) }] };
}

/**
 * Build the fleet tool set. Descriptions carry the operational contract (id
 * format, urgency values, when to use what) because the model sees nothing
 * else about the hub.
 */
export function buildFleetTools(request: FleetRequest): ToolDefinition[] {
	const tool = (
		name: string,
		label: string,
		description: string,
		parameters: ToolDefinition["parameters"],
		execute: (params: Record<string, unknown>) => Promise<unknown>,
	): ToolDefinition => ({
		name,
		label,
		description,
		parameters,
		async execute(_toolCallId, params) {
			return textResult(await execute(params as Record<string, unknown>));
		},
	});

	return [
		tool(
			"fleet_list_machines",
			"List fleet machines",
			[
				"List every machine registered with the omp hub, including connection state.",
				"Use this first when you need a machineId to start a session elsewhere.",
			].join(" "),
			type({}),
			async () => assertFetched(await request("GET", "/api/machines")).body,
		),
		tool(
			"fleet_list_sessions",
			"List fleet sessions",
			[
				"List every session across the fleet (all machines) with id, name, status, and machine.",
				"Use this to discover session ids before getting details, prompting, or stopping.",
			].join(" "),
			type({}),
			async () => assertFetched(await request("GET", "/api/sessions")).body,
		),
		tool(
			"fleet_get_session",
			"Get fleet session",
			[
				"Fetch one fleet session's full record by id.",
				"Ids look like `s_<name><random>` and come from fleet_list_sessions.",
			].join(" "),
			type({ id: type.string }),
			async params => assertFetched(await request("GET", `/api/sessions/${encodeURIComponent(String(params.id))}`)).body,
		),
		tool(
			"fleet_start_session",
			"Start fleet session",
			[
				"Start a new omp session on a machine (plain sessions only -- the fleet never spawns superagents).",
				"machineId: from fleet_list_machines. cwd: absolute directory on that machine.",
				"name: display label. prompt: first user turn to run immediately.",
				"profile: named omp profile on that machine (omit for the default).",
				"Returns the created session record including its id.",
			].join(" "),
			type({
				machineId: type.string,
				cwd: type.string,
				"name?": type.string,
				"prompt?": type.string,
				"profile?": type.string,
			}),
			async params =>
				assertFetched(
					await request("POST", "/api/sessions", {
						machineId: params.machineId,
						cwd: params.cwd,
						...(params.name === undefined ? {} : { name: params.name }),
						...(params.prompt === undefined ? {} : { prompt: params.prompt }),
						...(params.profile === undefined ? {} : { profile: params.profile }),
					}),
				).body,
		),
		tool(
			"fleet_stop_session",
			"Stop fleet session",
			[
				"Stop (terminate) a fleet session by id. The child process is asked to exit and killed after a grace period.",
				"The hub registry records the stop as a user stop; there is no custom-reason field.",
			].join(" "),
			type({ id: type.string }),
			async params =>
				assertFetched(await request("POST", `/api/sessions/${encodeURIComponent(String(params.id))}/stop`)).body,
		),
		tool(
			"fleet_prompt_session",
			"Prompt fleet session",
			[
				"Deliver a text prompt to a live fleet session; it runs as a new user turn.",
				"While the session is already streaming, the text is queued as steering and runs next.",
				"HTTP 409 means the session is not live (starting, exited, or failed) -- check fleet_list_sessions.",
				"text must be non-empty.",
			].join(" "),
			type({ id: type.string, text: type.string }),
			async params =>
				assertFetched(
					await request("POST", `/api/sessions/${encodeURIComponent(String(params.id))}/prompt`, { text: params.text }),
				).body,
		),
		tool(
			"fleet_notify_human",
			"Notify human",
			[
				"Post a notice to the humans watching the hub -- use when you need input, approval, or must report",
				"something important; not for routine progress.",
				"urgency: `info` (default) | `warn` | `urgent`. sessionId: attach the notice to one session (from fleet_list_sessions).",
			].join(" "),
			type({
				message: type.string,
				"urgency?": type.string,
				"sessionId?": type.string,
			}),
			async params =>
				assertFetched(
					await request("POST", "/api/notices", {
						message: params.message,
						...(params.urgency === undefined ? {} : { urgency: params.urgency }),
						...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
					}),
				).body,
		),
	];
}
