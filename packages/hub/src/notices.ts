/**
 * In-memory notice board (docs/protocol.md §3 `Notice`, 0.8.0+): the human-facing
 * notification channel agents post to and web clients poll for toasts.
 * Deliberately not persisted — restart drops them, like the registry itself.
 */
import { randomId } from "./sessions";

export type NoticeUrgency = "info" | "warn" | "urgent";

/** Protocol §3 `Notice`. */
export interface Notice {
	id: string;
	message: string;
	urgency: NoticeUrgency;
	sessionId?: string;
	createdAt: number;
}

export interface NoticeInput {
	message: unknown;
	urgency?: unknown;
	sessionId?: unknown;
}

/** Newest-first cap: toasts only care about the recent past. */
const NOTICE_CAP = 50;
const MAX_MESSAGE_CHARS = 2000;
const URGENCIES: readonly NoticeUrgency[] = ["info", "warn", "urgent"];

export class NoticeStore {
	readonly #notices: Notice[] = [];

	/** Validates and records one notice; throws on invalid input (the API maps it to 400). */
	add(input: NoticeInput): Notice {
		if (typeof input.message !== "string" || input.message.trim() === "" || input.message.length > MAX_MESSAGE_CHARS) {
			throw new Error(`message must be a non-empty string of at most ${MAX_MESSAGE_CHARS} characters`);
		}
		if (input.urgency !== undefined && !URGENCIES.includes(input.urgency as NoticeUrgency)) {
			throw new Error(`urgency must be one of ${URGENCIES.map((u) => `"${u}"`).join("|")}`);
		}
		if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.trim() === "")) {
			throw new Error("sessionId must be a non-empty string");
		}
		const notice: Notice = {
			id: randomId("n_"),
			message: input.message,
			urgency: (input.urgency as NoticeUrgency | undefined) ?? "info",
			...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
			createdAt: Date.now(),
		};
		this.#notices.unshift(notice);
		if (this.#notices.length > NOTICE_CAP) this.#notices.length = NOTICE_CAP;
		return notice;
	}

	/** Newest first, capped at the {@link NOTICE_CAP} most recent. */
	list(): Notice[] {
		return [...this.#notices];
	}
}
