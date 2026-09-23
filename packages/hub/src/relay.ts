/**
 * Collab relay (docs/protocol.md §1) — routed byte-identically to the upstream
 * `oh-my-pi/packages/collab-web/scripts/local-relay.ts`.
 *
 * The two envelope helpers are inlined on purpose: the hub must keep zero dependencies.
 * The relay never sees plaintext; payloads stay AES-GCM sealed end to end.
 */

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;

export type RelayRole = "host" | "guest";

export interface RelaySocketData {
	kind: "relay";
	roomId: string;
	role: RelayRole;
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
}

/** Structural socket surface — Bun's `ServerWebSocket` satisfies it. */
export interface RelaySocket {
	readonly data: RelaySocketData;
	send(data: string | Uint8Array): number;
	close(code?: number, reason?: string): void;
}

/** Structural server surface for the upgrade handshake. */
export interface RelayUpgradeServer {
	upgrade(req: Request, options: { data: RelaySocketData }): boolean;
}

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

/** `[4B uint32 BE peerId][sealed payload]` → parts, or null when the frame is too short. */
function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peerId in place without copying the payload. */
function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

function toBytes(message: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof message === "string") return new TextEncoder().encode(message);
	return message instanceof Uint8Array ? message : new Uint8Array(message);
}

function trySend(ws: RelaySocket, data: string | Uint8Array): void {
	try {
		ws.send(data);
	} catch {
		// The peer vanished mid-flight; its close handler performs the cleanup.
	}
}

export class CollabRelay {
	readonly rooms = new Map<string, Room>();

	/** `GET /r/<roomId>?role=host|guest`. Returns a Response on rejection, undefined once upgraded. */
	handleUpgrade(req: Request, server: RelayUpgradeServer): Response | undefined {
		const url = new URL(req.url);
		const match = ROOM_PATH_RE.exec(url.pathname);
		const role = url.searchParams.get("role");
		if (!match || (role !== "host" && role !== "guest")) {
			return new Response("not found", { status: 404 });
		}
		const data: RelaySocketData = { kind: "relay", roomId: match[1]!, role, peerId: 0 };
		if (server.upgrade(req, { data })) return undefined;
		return new Response("websocket upgrade required", { status: 426 });
	}

	handleOpen(ws: RelaySocket): void {
		const { roomId, role } = ws.data;
		if (role === "host") {
			if (this.rooms.has(roomId)) {
				ws.close(4009, "a host is already connected for this room");
				return;
			}
			this.rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
			return;
		}
		const room = this.rooms.get(roomId);
		if (!room) {
			ws.close(4004, "no such room");
			return;
		}
		const peerId = room.nextPeerId++;
		ws.data.peerId = peerId;
		room.guests.set(peerId, ws);
		trySend(room.host, JSON.stringify({ t: "peer-joined", peer: peerId }));
	}

	handleMessage(ws: RelaySocket, message: string | Uint8Array | ArrayBuffer): void {
		if (typeof message === "string") return; // clients never send TEXT
		const bytes = toBytes(message);
		const room = this.rooms.get(ws.data.roomId);
		if (!room) return;
		if (ws.data.role === "host") {
			const envelope = unpackEnvelope(bytes);
			if (!envelope) return;
			if (envelope.peerId === 0) {
				for (const guest of room.guests.values()) trySend(guest, bytes);
			} else {
				const guest = room.guests.get(envelope.peerId);
				if (guest) trySend(guest, bytes);
			}
			return;
		}
		if (bytes.byteLength < ENVELOPE_HEADER_LENGTH) return;
		rewriteEnvelopePeer(bytes, ws.data.peerId);
		trySend(room.host, bytes);
	}

	handleClose(ws: RelaySocket): void {
		const { roomId, role, peerId } = ws.data;
		const room = this.rooms.get(roomId);
		if (!room) return;
		if (role === "host") {
			// A rejected second host: the live room is not ours to tear down.
			if (room.host !== ws) return;
			this.rooms.delete(roomId);
			const closure = JSON.stringify({ t: "room-closed" });
			for (const guest of room.guests.values()) {
				trySend(guest, closure);
				try {
					guest.close(4001, "room closed");
				} catch {
					// Already closing.
				}
			}
			room.guests.clear();
			return;
		}
		if (room.guests.delete(peerId)) {
			trySend(room.host, JSON.stringify({ t: "peer-left", peer: peerId }));
		}
	}

	/** Shutdown path: tell every guest the room is gone, then drop the rooms. */
	closeAll(reason = "relay shutting down"): void {
		const closure = JSON.stringify({ t: "room-closed" });
		for (const room of this.rooms.values()) {
			for (const guest of room.guests.values()) {
				trySend(guest, closure);
				try {
					guest.close(4001, "room closed");
				} catch {
					// Already closing.
				}
			}
			try {
				room.host.close(1001, reason);
			} catch {
				// Already closing.
			}
		}
		this.rooms.clear();
	}
}
