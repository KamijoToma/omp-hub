/**
 * Dependency-free path router (docs/protocol.md §5): `/`, `/s/<id>`, `/join`.
 *
 * The URL fragment is reserved for the collab link channel, so routing is
 * path-based. `useRoute` reads `location.pathname` through
 * `useSyncExternalStore`, so `pushState`/`replaceState` + `popstate` are the
 * only navigation primitives.
 */
import { useSyncExternalStore } from "react";

export type Route =
	| { kind: "home" }
	| { kind: "session"; id: string }
	| { kind: "usage"; machineId: string }
	| { kind: "join" }
	| { kind: "unknown" };

const SESSION_PATH = /^\/s\/([^/]+)\/?$/;
const USAGE_PATH = /^\/usage\/([^/]+)\/?$/;

export function parseRoute(pathname: string): Route {
	if (pathname === "" || pathname === "/") return { kind: "home" };
	if (pathname === "/join" || pathname === "/join/") return { kind: "join" };
	const match = SESSION_PATH.exec(pathname);
	if (match) return { kind: "session", id: decodeURIComponent(match[1]) };
	const usage = USAGE_PATH.exec(pathname);
	if (usage) return { kind: "usage", machineId: decodeURIComponent(usage[1]) };
	return { kind: "unknown" };
}

const listeners = new Set<() => void>();

/** Path snapshot cache: `getSnapshot` must stay referentially stable per path. */
let cachedPath = typeof window === "undefined" ? "/" : window.location.pathname;
let cachedRoute: Route = parseRoute(cachedPath);

function currentRoute(): Route {
	const path = window.location.pathname;
	if (path !== cachedPath) {
		cachedPath = path;
		cachedRoute = parseRoute(path);
	}
	return cachedRoute;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(): void {
	for (const listener of listeners) listener();
}

if (typeof window !== "undefined") window.addEventListener("popstate", emit);

export function navigate(path: string, replace = false): void {
	if (replace) history.replaceState(null, "", path);
	else history.pushState(null, "", path);
	emit();
}

export function useRoute(): Route {
	return useSyncExternalStore(subscribe, currentRoute);
}
