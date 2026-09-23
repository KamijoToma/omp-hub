/**
 * Cross-session alerts for the session page (protocol §3 `SessionRecord.activity`).
 *
 * The polled hub listing is diffed into "needs input" / "exited" transitions
 * and delivered where the user actually is: a system notification when the
 * browser allows one and the session is not already on screen, otherwise an
 * in-page toast (the caller's `notify`) plus a flashing document title while
 * the tab is hidden.
 */
import type { SessionRecord } from "./api";
import { navigate } from "./router";

export type SessionAlertKind = "input" | "exited";

export interface SessionAlert {
	sessionId: string;
	sessionName: string;
	kind: SessionAlertKind;
}

/** Storage key behind the drawer's bell toggle (`"1"` = on). */
export const ALERTS_ENABLED_KEY = "omp-hub.notify";

/**
 * In-memory mirror of the toggle. localStorage is missing or throws in some
 * contexts (tests, private mode); the flag must still hold for the life of
 * the page instead of silently flipping back.
 */
let alertsMemory: boolean | null = null;

/** Side-poll cadence for the alert watcher (slower than the drawer's list poll). */
export const ALERT_POLL_MS = 5000;

export function alertsEnabled(): boolean {
	if (alertsMemory !== null) return alertsMemory;
	try {
		return (alertsMemory = globalThis.localStorage?.getItem(ALERTS_ENABLED_KEY) === "1");
	} catch {
		return (alertsMemory = false);
	}
}

export function setAlertsEnabled(enabled: boolean): void {
	alertsMemory = enabled;
	try {
		if (enabled) globalThis.localStorage?.setItem(ALERTS_ENABLED_KEY, "1");
		else globalThis.localStorage?.removeItem(ALERTS_ENABLED_KEY);
	} catch {
		// persistence is best-effort; the in-memory value still serves this page
	}
}

/**
 * Turns a listing refresh into alerts: `input` fires on the false→true
 * `inputRequired` edge, `exited` on any → `exited`. Brand-new records are not
 * interruptions (the user just started or a poll caught up), and a session
 * never alerts twice for the same edge.
 */
export function diffSessionAlerts(prev: readonly SessionRecord[], next: readonly SessionRecord[]): SessionAlert[] {
	const before = new Map(prev.map(record => [record.id, record]));
	const alerts: SessionAlert[] = [];
	for (const record of next) {
		const was = before.get(record.id);
		if (was === undefined) continue;
		if (was.activity?.inputRequired !== true && record.activity?.inputRequired === true) {
			alerts.push({ sessionId: record.id, sessionName: record.name, kind: "input" });
		} else if (was.status !== "exited" && record.status === "exited") {
			alerts.push({ sessionId: record.id, sessionName: record.name, kind: "exited" });
		}
	}
	return alerts;
}

/** Notification copy for one alert. */
export function alertText(alert: SessionAlert): { title: string; body: string } {
	if (alert.kind === "input") {
		return {
			title: `${alert.sessionName} needs input`,
			body: "the agent is waiting on a dialog — open the hub to answer",
		};
	}
	return { title: `${alert.sessionName} finished`, body: "the session exited" };
}

/** True when a system notification is both permitted and useful (not already on screen). */
export function shouldSystemNotify(alert: SessionAlert, currentId: string, hidden: boolean, permission: string): boolean {
	if (permission !== "granted") return false;
	return hidden || alert.sessionId !== currentId;
}

/**
 * Fires system notifications for the alerts that qualify and returns the rest
 * for the caller's in-page fallback (toast + title flash).
 */
export function deliverSystemAlerts(alerts: readonly SessionAlert[], currentId: string): SessionAlert[] {
	const hidden = typeof document === "undefined" ? false : document.hidden;
	const permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
	const remaining: SessionAlert[] = [];
	for (const alert of alerts) {
		if (!shouldSystemNotify(alert, currentId, hidden, permission)) {
			remaining.push(alert);
			continue;
		}
		try {
			const text = alertText(alert);
			const notification = new Notification(text.title, {
				body: text.body,
				tag: `omp-hub-${alert.sessionId}-${alert.kind}`,
			});
			notification.onclick = (): void => {
				window.focus();
				navigate(`/s/${alert.sessionId}`);
			};
		} catch {
			// some platforms throw on construction; fall back to the toast path
			remaining.push(alert);
		}
	}
	return remaining;
}

/** Asks for Notification permission on first enable; never throws. */
export async function requestAlertPermission(): Promise<NotificationPermission | "unsupported"> {
	if (typeof Notification === "undefined") return "unsupported";
	if (Notification.permission === "default") {
		try {
			return await Notification.requestPermission();
		} catch {
			return "denied";
		}
	}
	return Notification.permission;
}

// ---- title flash fallback (tab hidden, no Notification permission) ----

let flashInterval: Timer | null = null;
let flashBase = "";
let flashMessage = "";
let flashOn = false;
let flashListening = false;

function stopFlashOnVisible(): void {
	if (document.visibilityState === "visible") stopTitleFlash();
}

/** Flips the document title between the base and `⚠ <message>` until the tab becomes visible. */
export function startTitleFlash(message: string): void {
	if (flashInterval !== null) {
		flashMessage = message;
		return;
	}
	flashBase = document.title;
	flashMessage = message;
	flashOn = false;
	flashInterval = setInterval(() => {
		flashOn = !flashOn;
		document.title = flashOn ? `\u26a0 ${flashMessage}` : flashBase;
	}, 1_200);
	if (!flashListening) {
		document.addEventListener("visibilitychange", stopFlashOnVisible);
		flashListening = true;
	}
}

/** Restores the title and stops flashing (also runs when the tab becomes visible). */
export function stopTitleFlash(): void {
	if (flashInterval === null) return;
	clearInterval(flashInterval);
	flashInterval = null;
	document.title = flashBase;
}
