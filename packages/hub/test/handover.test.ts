/**
 * Hot-reload handover: `buildHub` → `drain` → `adopt` moves machines, session
 * records, agent sockets, and relay rooms between cores — a socket handled by
 * the old core keeps working under the new one (unit level; the live swap is
 * exercised by the `--watch` E2E).
 */
import { describe, expect, test } from "bun:test";
import type { AgentSocket, AgentSocketData } from "../src/agents";
import type { RelaySocket, RelaySocketData } from "../src/relay";
import { buildHub } from "../src/server";

function agentSocket(machineId: string | null): AgentSocket & { sent: string[] } {
	const sent: string[] = [];
	return {
		data: { kind: "agent", machineId, httpBase: "http://h", wsBase: "ws://h" } satisfies AgentSocketData,
		send: (data: string) => sent.push(data),
		close: () => {},
		sent,
	};
}

function relaySocket(roomId: string, peerId: number): RelaySocket & { sent: (string | Uint8Array)[] } {
	const sent: (string | Uint8Array)[] = [];
	return {
		data: { kind: "relay", roomId, role: "guest", peerId } satisfies RelaySocketData,
		send: (data: string | Uint8Array) => sent.push(data),
		close: () => {},
		sent,
	};
}

describe("hot-reload handover", () => {
	test("drain/adopt moves registries, sockets, and rooms between cores", () => {
		const cfg = { port: 0, hostname: "127.0.0.1", token: "t", stateFile: null } as const;
		const a = buildHub(cfg, { restoreState: false });
		const ws = agentSocket(null);
		a.agents.handleMessage(ws, JSON.stringify({ t: "hello", machineId: "m_1", name: "dev", version: "test" }));
		const created = a.sessions.create({ machineId: "m_1", machineName: "dev", cwd: "/srv/work" });
		const guest = relaySocket("roomabcdefgh", 1);
		a.relay.rooms.set("roomabcdefgh", {
			host: relaySocket("roomabcdefgh", 0),
			guests: new Map([[1, guest]]),
			nextPeerId: 2,
		});

		const drained = a.drain();
		// The old core is empty after the drain — sockets have one owner.
		expect(a.agents.listMachines()).toEqual([]);
		expect(a.sessions.list()).toEqual([]);
		expect(a.relay.rooms.size).toBe(0);

		const b = buildHub(cfg, { restoreState: false });
		b.adopt(drained);
		const machines = b.agents.listMachines();
		expect(machines.map((machine) => machine.machineId)).toEqual(["m_1"]);
		// The adopted connection was already past `hello`: still connected.
		expect(machines[0]!.connected).toBe(true);
		expect(b.sessions.list().map((record) => record.id)).toEqual([created.id]);
		// Rooms move by identity — guests keep their peer ids and sockets.
		const room = b.relay.rooms.get("roomabcdefgh");
		expect(room?.nextPeerId).toBe(2);
		expect(room?.guests.get(1)).toBe(guest);

		// The adopted agent connection still speaks to the new core.
		expect(() => b.agents.handleMessage(ws, JSON.stringify({ t: "hb", ts: 1, sessions: [] }))).not.toThrow();
		// And the adopted guest still receives the new core's broadcasts.
		b.relay.closeAll();
		expect(guest.sent).toContain(JSON.stringify({ t: "room-closed" }));
	});
});
