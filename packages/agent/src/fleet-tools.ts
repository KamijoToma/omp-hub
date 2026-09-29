/**
 * Namespace-scoped fleet tools for superagent sessions. The daemon supplies
 * authenticated owner identity; these tools never accept an identity field.
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

/** JSON is model-visible text; details preserves the same structured payload for consumers. */
function textResult(body: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
	const details = body ?? null;
	return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
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

	const sessionPath = (id: unknown): string => `/api/fleet/sessions/${encodeURIComponent(String(id))}`;
	return [
		tool("fleet_list_machines", "List fleet machines", "Machines available in your namespace, with connection status.", type({}),
			async () => assertFetched(await request("GET", "/api/fleet/machines")).body),
		tool("fleet_list_sessions", "List fleet sessions", "Sessions visible in your namespace.", type({}),
			async () => assertFetched(await request("GET", "/api/fleet/sessions")).body),
		tool("fleet_get_session", "Get fleet session", "Read one namespace session record by id.", type({ id: type.string }),
			async p => assertFetched(await request("GET", sessionPath(p.id))).body),
		tool("fleet_start_session", "Start fleet session",
			"Start a plain worker on a namespace machine. It is watched and you become its controller immediately. cwd is an absolute machine path; prompt is an optional first turn. forkFrom optionally copies an idle worker's current persisted history into a new independent session on the same machine and cwd (with the same profile); the source remains unchanged.",
			type({ machineId: type.string, cwd: type.string, "name?": type.string, "prompt?": type.string, "profile?": type.string, "forkFrom?": type.string }),
			async p => assertFetched(await request("POST", "/api/fleet/sessions", {
				machineId: p.machineId, cwd: p.cwd,
				...(p.name === undefined ? {} : { name: p.name }),
				...(p.prompt === undefined ? {} : { prompt: p.prompt }),
				...(p.profile === undefined ? {} : { profile: p.profile }),
				...(p.forkFrom === undefined ? {} : { forkFrom: p.forkFrom }),
			})).body),
		tool("fleet_claim_session", "Claim worker control",
			"Become the controller of a namespace worker before mutating an existing session; another controller may prevent claiming.",
			type({ id: type.string }), async p => assertFetched(await request("POST", `${sessionPath(p.id)}/claim`, {})).body),
		tool("fleet_watch_session", "Watch worker", "Subscribe to durable worker events without claiming control.",
			type({ id: type.string }), async p => assertFetched(await request("POST", `${sessionPath(p.id)}/watch`, {})).body),
		tool("fleet_stop_session", "Stop worker", "Terminate a worker you control.", type({ id: type.string }),
			async p => assertFetched(await request("POST", `${sessionPath(p.id)}/stop`, {})).body),
		tool("fleet_message_session", "Message worker",
			"Send a new turn (start) when idle; steer interrupts the current reasoning at its next step, follow_up queues for after the current turn. Claim control first for an existing worker.",
			type({ id: type.string, text: type.string, mode: type.enumerated("start", "steer", "follow_up") }),
			async p => assertFetched(await request("POST", `${sessionPath(p.id)}/message`, { text: p.text, mode: p.mode })).body),
		tool("fleet_interrupt_session", "Interrupt worker",
			"Abort its current turn. Optionally clear queued messages and send replacement text as a fresh turn after abort. Requires control.",
			type({ id: type.string, "text?": type.string, "clearQueue?": type.boolean }),
			async p => assertFetched(await request("POST", `${sessionPath(p.id)}/interrupt`, {
				...(p.text === undefined ? {} : { text: p.text }),
				...(p.clearQueue === undefined ? {} : { clearQueue: p.clearQueue }),
			})).body),
		tool("fleet_get_messages", "Read worker messages",
			"Without cursor return the latest messages (20 by default); messages stay chronological. Pass nextCursor (the oldest returned id) as cursor to page strictly earlier history while hasMore is true. Includes tool output and custom messages; leafId identifies the current branch tip.",
			type({ id: type.string, "cursor?": type.string, "limit?": type.number }),
			async p => {
				const query = new URLSearchParams();
				if (typeof p.cursor === "string" && p.cursor.trim()) query.set("cursor", p.cursor.trim());
				if (p.limit !== undefined) query.set("limit", String(p.limit));
				return assertFetched(await request("GET", `${sessionPath(p.id)}/messages${query.size ? `?${query}` : ""}`)).body;
			}),
		tool("fleet_search_messages", "Search worker messages",
			"Search one namespace worker's active branch, including stored text, tool-call arguments and tool results before message truncation. Use a literal case-insensitive query (1–256 characters) and/or inclusive from / exclusive to ISO-8601 timestamps with timezone. The newest 20 matches (max 50) arrive chronologically; nextCursor fetches older matches. Snippets are short: omit query and set a time window around a hit to inspect nearby messages. fleet_get_messages reads bounded messages from the newest turn backward, not directly by hit id.",
			type({ id: type.string, "query?": type.string, "from?": type.string, "to?": type.string,
				"cursor?": type.string, "limit?": type.number }),
			async p => {
				const query = new URLSearchParams();
				for (const key of ["query", "from", "to", "cursor", "limit"] as const) {
					if (p[key] !== undefined) query.set(key, String(p[key]));
				}
				return assertFetched(await request("GET", `${sessionPath(p.id)}/search?${query}`)).body;
			}),
		tool("fleet_get_input", "Read worker input",
			"List pending select/editor/ask steps, including requestId. Can answer even if no human guest is connected.",
			type({ id: type.string }), async p => assertFetched(await request("GET", `${sessionPath(p.id)}/input`)).body),
		tool("fleet_answer_input", "Answer worker input",
			"Answer one pending request by its requestId; first answer wins across human guests and fleet controller. For select use the displayed option label.",
			type({ id: type.string, requestId: type.string, answer: type.string }),
			async p => assertFetched(await request("POST", `${sessionPath(p.id)}/input`, { requestId: p.requestId, answer: p.answer })).body),
		tool("fleet_list_events", "Read fleet events",
			"Durable notifications of watched workers' pending/resolved input and terminal turns. Ack processed events.",
			type({}), async () => assertFetched(await request("GET", "/api/fleet/events")).body),
		tool("fleet_ack_event", "Acknowledge fleet event", "Remove one processed durable event from your inbox.",
			type({ eventId: type.string }),
			async p => assertFetched(await request("POST", `/api/fleet/events/${encodeURIComponent(String(p.eventId))}/ack`, {})).body),
		tool("fleet_notify_human", "Notify human",
			"Post a notice for human operators. urgency is info, warn or urgent. Optional sessionId attaches it to a visible session.",
			type({ message: type.string, "urgency?": type.string, "sessionId?": type.string }),
			async p => assertFetched(await request("POST", "/api/fleet/notices", {
				message: p.message,
				...(p.urgency === undefined ? {} : { urgency: p.urgency }),
				...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
			})).body),
	];
}
