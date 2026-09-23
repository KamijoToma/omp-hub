/**
 * Live session surface for `/s/<id>`.
 *
 * This is the hub-side adaptation of the vendored `Session` component
 * (`src/guest/app.tsx`): it owns the `GuestClient` lifecycle for one collab
 * link and renders the same shell leaves — HeaderBar, Transcript, agents rail,
 * Composer, AgentDrawer, Banners, Toasts.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "../components/agents/AgentDrawer";
import { AgentsPanel } from "../components/agents/AgentsPanel";
import { Banners } from "../components/shell/Banners";
import { Composer } from "../components/shell/Composer";
import { HeaderBar } from "../components/shell/HeaderBar";
import { Toasts } from "../components/shell/Toasts";
import { Transcript } from "../components/transcript/Transcript";
import { GuestClient } from "../lib/client";
import { useGuestSnapshot } from "../lib/use-guest";
import type { ToolRenderHost } from "../tool-render";

export interface SessionViewProps {
	/** Full (write) collab link from the session record. */
	link: string;
	displayName: string;
	onLeave(): void;
}

export function SessionView({ link, displayName, onLeave }: SessionViewProps): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Bumping re-mints the client for the same link (the Banners "Rejoin" action).
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, displayName);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		setClient(next);
		setError(null);
		return () => next.close();
	}, [link, displayName, attempt]);

	const rejoin = useCallback(() => setAttempt(n => n + 1), []);

	if (error) {
		return (
			<div className="sh-connect">
				<div className="sh-connect-card">
					<div className="sh-connect-sub">This session link could not be parsed.</div>
					<div className="sh-connect-error" role="alert">
						{error}
					</div>
					<button type="button" className="sh-btn" onClick={onLeave}>
						Back to hub
					</button>
				</div>
			</div>
		);
	}
	if (!client) return null;
	return <Session client={client} onLeave={onLeave} onRejoin={rejoin} />;
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
}

function Session({ client, onLeave, onRejoin }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp hub`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
						/>
					</div>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			<Composer client={client} snapshot={snap} />
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			<Toasts notices={snap.notices} />
		</div>
	);
}
