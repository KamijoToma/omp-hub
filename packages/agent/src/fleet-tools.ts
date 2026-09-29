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
		tool("fleet_search_messages", "Search fleet messages",
			"Search persisted visible text, tool-call arguments and tool results before truncation. Minimal namespace call: {query:\"git merge main\"}; no preliminary message read or cursor is needed. Add id to search one session; otherwise search your current namespace, optionally narrowed by sessionIds, machineIds or exact session cwd. Do not combine id with these scope filters. query is literal and case-insensitive (1–256 characters); optional from is inclusive and to exclusive, using timezone-qualified timestamps such as 2026-09-30T00:00:00Z. Omit time bounds for all history and cursor for the newest matches; blank time/cursor values are omitted. Arrays roles/toolNames/sources/fields filter with AND between categories and OR within one category. sources: text/toolCall/toolResult/custom. fields: text/toolResult/custom/toolCall.arguments or a dotted argument path such as toolCall.arguments.command (excludes matches only in cwd or documentation). Default limit20, max50. Namespace results are newest-first with explicit partial/coverage; single-session pages are chronological. Reuse nextCursor unchanged with the same query/filters; namespace cursors are not message ids. Read hit evidence with fleet_get_message({id:hit.sessionId,messageId:hit.id,toolCallId:hit.toolCallId}); match.contentCursor reads the original match region, including beyond truncated output.",
			type({ "id?": type.string, "query?": type.string, "from?": type.string, "to?": type.string,
				"cursor?": type.string, "limit?": type.number, "sessionIds?": type.string.array(),
				"machineIds?": type.string.array(), "cwd?": type.string, "roles?": type.string.array(),
				"toolNames?": type.string.array(), "sources?": type.enumerated("text", "toolCall", "toolResult", "custom").array(),
				"fields?": type.string.array() }),
			async p => {
				if (p.id !== undefined && (typeof p.id !== "string" || !p.id.trim())) throw new Error("fleet: id must be a nonblank session id; omit id for namespace search");
				if (p.id !== undefined && (p.sessionIds !== undefined || p.machineIds !== undefined || p.cwd !== undefined)) {
					throw new Error("fleet: do not combine id with sessionIds, machineIds or cwd");
				}
				const body: Record<string, unknown> = {};
				for (const key of ["query", "from", "to", "cursor", "limit", "sessionIds", "machineIds", "cwd", "roles", "toolNames", "sources", "fields"] as const) {
					const value = p[key];
					if (value === undefined) continue;
					if (key === "from" || key === "to" || key === "cursor") {
						if (typeof value === "string" && !value.trim()) continue;
						body[key] = typeof value === "string" ? value.trim() : value;
					} else body[key] = value;
				}
				if (p.id === undefined) return assertFetched(await request("POST", "/api/fleet/search", body)).body;
				const query = new URLSearchParams();
				for (const [key, value] of Object.entries(body)) query.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
				return assertFetched(await request("GET", `${sessionPath(p.id)}/search?${query}`)).body;
			}),
		tool("fleet_get_message", "Read anchored fleet evidence",
			"Read a search hit by message entry id, always including that anchor. id is the hit's sessionId and messageId is the hit's id. before/after select 0–10 visible neighbors (defaults1/2); tool calls and nonadjacent results are also paired by toolCallId. Optional toolCallId restricts pairing to that anchor's call. Messages remain chronological and bounded; contextTruncated signals omitted context. Optional leafId freezes context at that active branch ancestor; omit it to include results appended since search. To read full visible content, pass the anchor's contentCursor, or match.contentCursor from search to jump near a hit beyond truncation. The content chunk identifies block/argument path and offset; repeat with content.nextCursor until null. Hidden/reasoning/image payloads never leave this interface. A removed anchor/snapshot is a conflict, not a fallback to newer history.",
			type({ id: type.string, messageId: type.string, "before?": type.number, "after?": type.number,
				"leafId?": type.string, "toolCallId?": type.string, "contentCursor?": type.string }),
			async p => {
				const body: Record<string, unknown> = { messageId: p.messageId };
				for (const key of ["before", "after", "leafId", "toolCallId", "contentCursor"] as const) {
					if (p[key] !== undefined) body[key] = p[key];
				}
				return assertFetched(await request("POST", `${sessionPath(p.id)}/message-context`, body)).body;
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
