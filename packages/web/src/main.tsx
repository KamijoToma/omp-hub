/**
 * Hub SPA boot: path router over the vendored collab guest client.
 *
 * `/` → token gate, then home (machines + start form + sessions)
 * `/s/<id>` → token gate, then the live session
 * `/join` → vendored connect screen / guest session (no hub token needed)
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import GuestApp from "./guest/app";
import { clearToken, getToken, onUnauthorized } from "./hub/api";
import { HomePage } from "./hub/HomePage";
import { clientPool } from "./hub/client-pool";
import "./hub/highlight";
import { SessionPage } from "./hub/SessionPage";
import { sessionsStore } from "./hub/sessions-store";
import { WarmSessions } from "./hub/WarmSessions";
import { TokenGate } from "./hub/TokenGate";
import { UsagePage } from "./hub/UsagePage";
import { useNoticeToasts } from "./hub/notices-store";
import { navigate, useRoute } from "./hub/router";
import { parseCollabLink } from "./lib/link";
import "./styles/tokens.css";
import "./styles/base.css";
import "./components/shell/shell.css";
import "./hub/hub.css";

/**
 * Legacy deep links carry the collab link in the URL fragment (`/#<link>`).
 * The fragment is the collab link channel, so such a load is normalized onto
 * `/join` — fragment preserved — before the first render; the guest app reads
 * it on mount.
 */
function normalizeDeepLink(): void {
	if (window.location.pathname !== "/") return;
	const href = window.location.href;
	const hashAt = href.indexOf("#");
	if (hashAt < 0 || hashAt + 1 >= href.length) return;
	const link = href.slice(hashAt + 1);
	if ("error" in parseCollabLink(link)) return;
	history.replaceState(null, "", `/join${href.slice(hashAt)}`);
}

normalizeDeepLink();

/** Hub-page side watcher: toasts hub notices arriving while the page is open. */
function NoticeToasts(): ReactNode {
	useNoticeToasts();
	return null;
}

function Shell(): ReactNode {
	const route = useRoute();
	const [token, setToken] = useState<string | null>(() => getToken());

	// Unknown paths fall back to the hub home.
	useEffect(() => {
		if (route.kind === "unknown") navigate("/", true);
	}, [route]);

	useEffect(() => {
		if (route.kind !== "session") document.title = "omp hub";
	}, [route.kind]);

	const logout = useCallback((): void => {
		clearToken();
		clientPool.closeAll();
		sessionsStore.clear();
		setToken(null);
		navigate("/", true);
	}, []);

	useEffect(() => {
		if (!token) return;
		return onUnauthorized(logout);
	}, [token, logout]);

	if (route.kind === "unknown") return null;
	if (route.kind === "join") return <GuestApp />;
	if (!token) return <TokenGate onReady={setToken} />;
	// The connection manager survives route changes but is absent from /join
	// and the token gate. It never keeps React session surfaces mounted.
	return (
		<>
			<WarmSessions currentId={route.kind === "session" ? route.id : null} />
			{route.kind === "session" ? (
				<SessionPage id={route.id} />
			) : route.kind === "usage" ? (
				<UsagePage machineId={route.machineId} />
			) : (
				<HomePage onLogout={logout} />
			)}
			<NoticeToasts />
		</>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Shell />);
