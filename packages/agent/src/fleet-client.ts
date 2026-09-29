/**
 * Child-side fleet IPC client (protocol 0.8.0 `fleet-req`/`fleet-res`).
 *
 * A superagent session's fleet tools call the hub API through the parent
 * daemon (which holds `HUB_TOKEN`): each request is one JSONL frame on stdout,
 * correlated back by `reqId`. The child abandons an unanswered request after
 * 30 s; late or unknown-`reqId` replies are dropped.
 */

import { randomBytes } from "node:crypto";

/** One proxied hub call: exactly one of the two shapes. */
export type FleetResult = { ok: true; status: number; body?: unknown } | { ok: false; error: string };

/** Unanswered `fleet-req`s the client still owes a tool. */
interface PendingFleetRequest {
	resolve(result: FleetResult): void;
	timer: Timer;
}

/** Child abandons an unanswered `fleet-req` after this long (protocol 0.8.0). */
const FLEET_TIMEOUT_MS = 30_000;

export interface FleetClient {
	request(method: string, path: string, body?: unknown): Promise<FleetResult>;
	handleFrame(frame: unknown): void;
}

let fleetReqCounter = 0;

/** `f_` + counter + randomness: no collision across concurrent calls. */
function nextFleetReqId(): string {
	fleetReqCounter += 1;
	return `f_${fleetReqCounter}_${randomBytes(6).toString("hex")}`;
}

/**
 * Create the child-side fleet client. `write` is the raw stdout frame writer
 * (the same channel `ready`/`cmd-result` use); it must stay JSONL-clean.
 */
export function createFleetClient(write: (line: string) => void, log?: { warn(message: string): void }): FleetClient {
	const pending = new Map<string, PendingFleetRequest>();

	const settle = (reqId: string, result: FleetResult): void => {
		const entry = pending.get(reqId);
		if (!entry) {
			// Late reply after the tool's 30 s timeout, or a foreign reqId.
			log?.warn(`dropping fleet-res for unknown reqId ${reqId}`);
			return;
		}
		pending.delete(reqId);
		clearTimeout(entry.timer);
		entry.resolve(result);
	};

	return {
		request(method, path, body) {
			const reqId = nextFleetReqId();
			const { promise, resolve } = Promise.withResolvers<FleetResult>();
			const timer = setTimeout(() => settle(reqId, { ok: false, error: "fleet: request timeout" }), FLEET_TIMEOUT_MS);
			// Never hold the child open for an abandoned request.
			timer.unref?.();
			pending.set(reqId, { resolve, timer });
			write(`${JSON.stringify({ t: "fleet-req", reqId, method, path, ...(body === undefined ? {} : { body }) })}\n`);
			return promise;
		},
		handleFrame(frame) {
			if (typeof frame !== "object" || frame === null) return;
			const parsed = frame as { t?: unknown; reqId?: unknown; ok?: unknown };
			if (parsed.t !== "fleet-res") return;
			const reqId = typeof parsed.reqId === "string" ? parsed.reqId : "";
			if (!reqId) return;
			if (parsed.ok === true) {
				const result = parsed as { status?: unknown; body?: unknown };
				settle(reqId, {
					ok: true,
					status: typeof result.status === "number" ? result.status : 0,
					...(result.body === undefined ? {} : { body: result.body }),
				});
			} else {
				const error =
					typeof (parsed as { error?: unknown }).error === "string"
						? (parsed as { error: string }).error
						: "fleet: request failed";
				settle(reqId, { ok: false, error });
			}
		},
	};
}
