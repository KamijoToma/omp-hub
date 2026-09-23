/**
 * Live session surface for `/s/<id>`.
 *
 * This is the hub-side adaptation of the vendored `Session` component
 * (`src/guest/app.tsx`): it owns the `GuestClient` lifecycle for one collab
 * link and renders the same shell leaves — HeaderBar, Transcript, agents rail,
 * Composer, AgentDrawer, Banners, Toasts.
 *
 * On top of that shell it hosts the web slash commands (docs/protocol.md §6).
 * The vendored `Composer` stays untouched: it receives a wrapped client whose
 * `sendPrompt` routes leading-slash text through `commands.ts` instead of the
 * relay, the composer wrapper (a plain `div` around `Composer`) mirrors the
 * textarea's value to float the palette, and the command dialogs render here.
 */
import type { FocusEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "../components/agents/AgentDrawer";
import { AgentsPanel } from "../components/agents/AgentsPanel";
import { Banners } from "../components/shell/Banners";
import { Composer } from "../components/shell/Composer";
import { HeaderBar } from "../components/shell/HeaderBar";
import { Toasts } from "../components/shell/Toasts";
import { Transcript } from "../components/transcript/Transcript";
import { GuestClient } from "../lib/client";
import type { Notice } from "../lib/client";
import { useThemePreference } from "../lib/theme";
import { useGuestSnapshot } from "../lib/use-guest";
import type { ToolRenderHost } from "../tool-render";
import type { SessionRecord } from "./api";
import { errorText, postCompact, postExtendedContext, postRetry } from "./api";
import type { CommandContext, CompactRequest, ModalKind } from "./commands";
import {
	commandQuery,
	createComposerClient,
	dumpFileName,
	matchCommands,
	routeComposerText,
	transcriptJsonl,
} from "./commands";
import { ContextModal } from "./ContextModal";
import { GoalModal } from "./GoalModal";
import { HelpModal } from "./HelpModal";
import { LinksModal } from "./LinksModal";
import { LoopModal } from "./LoopModal";
import { ModelPicker } from "./ModelPicker";
import { RewindPicker } from "./RewindPicker";
import { navigate } from "./router";
import { SettingsModal } from "./SettingsModal";
import { SlashPalette } from "./SlashPalette";
import { ThinkingPicker } from "./ThinkingPicker";
import { TodosModal } from "./TodosModal";

/** Local notices never collide with the client's sequence (which starts at 1). */
const LOCAL_NOTICE_BASE = 1_000_000;
/** Local notices kept around; `Toasts` shows at most the newest four. */
const MAX_LOCAL_NOTICES = 20;
/** Grace period before releasing the dump blob URL (some browsers start late). */
const BLOB_URL_TTL_MS = 10_000;

export interface SessionViewProps {
	/** Hub-assigned session id (`/s/<id>`), the key for the agent-state API. */
	sessionId: string;
	/** Full (write) collab link from the session record. */
	link: string;
	/** Hub record for this session — names, links, machine. */
	record: SessionRecord | null;
	displayName: string;
	onLeave(): void;
}

export function SessionView({ sessionId, link, record, displayName, onLeave }: SessionViewProps): ReactNode {
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
	return <Session client={client} sessionId={sessionId} record={record} onLeave={onLeave} onRejoin={rejoin} />;
}

interface SessionProps {
	client: GuestClient;
	sessionId: string;
	record: SessionRecord | null;
	onLeave(): void;
	onRejoin(): void;
}

function Session({ client, sessionId, record, onLeave, onRejoin }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [modal, setModal] = useState<ModalKind | null>(null);
	// Composer text mirrored from the vendored textarea (which owns the draft state).
	const [paletteText, setPaletteText] = useState("");
	const [paletteIndex, setPaletteIndex] = useState(0);
	// Set by Esc/blur/command-run; the next keystroke brings the palette back.
	const [paletteDismissed, setPaletteDismissed] = useState(false);
	const [localNotices, setLocalNotices] = useState<readonly Notice[]>([]);
	const noticeSeqRef = useRef(0);
	const autoOpenedRef = useRef(false);
	const {
		preference: themePreference,
		resolved: themeResolved,
		setPreference: setThemePreference,
	} = useThemePreference();

	/** Toast: local notices ride the vendored `Toasts` list, newest last. */
	const notify = useCallback((level: Notice["level"], message: string): void => {
		noticeSeqRef.current += 1;
		const notice: Notice = { id: LOCAL_NOTICE_BASE + noticeSeqRef.current, level, message, at: Date.now() };
		setLocalNotices(prev => {
			const next = [...prev, notice];
			return next.length > MAX_LOCAL_NOTICES ? next.slice(-MAX_LOCAL_NOTICES) : next;
		});
	}, []);

	const toggleTheme = useCallback((): void => {
		setThemePreference(themeResolved === "dark" ? "light" : "dark");
	}, [themeResolved, setThemePreference]);

	// `/dump`: the transcript snapshot as JSONL, handed to the browser as a download.
	const downloadDump = useCallback((): void => {
		const name = record?.name ?? snap.header?.title ?? snap.state?.sessionName ?? "session";
		const blob = new Blob([transcriptJsonl(snap.entries)], { type: "application/x-ndjson" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = dumpFileName(name, new Date());
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
	}, [record?.name, snap.header?.title, snap.state?.sessionName, snap.entries]);

	// `/compact`, `/retry`, `/extended-context`: fire the hub command, toast the outcome.
	const compactSession = useCallback(
		(request: CompactRequest): void => {
			void postCompact(sessionId, request).then(
				() => notify("info", "compaction started"),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	const retrySession = useCallback((): void => {
		void postRetry(sessionId).then(
			() => notify("info", "retrying last failed turn"),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	const setExtendedContext = useCallback(
		(enabled?: boolean): void => {
			void postExtendedContext(sessionId, { enabled }).then(
				on => notify("info", `extended context ${on ? "on" : "off"}`),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	// Latest command context, so the long-lived composer wrapper never sees a stale one.
	const ctx: CommandContext = {
		openModal: setModal,
		toggleTheme,
		navigate,
		downloadDump,
		notify,
		compactSession,
		retrySession,
		setExtendedContext,
	};
	const ctxRef = useRef(ctx);
	useEffect(() => {
		ctxRef.current = ctx;
	});

	/**
	 * Interception: the Composer calls this instead of `client.sendPrompt`. A
	 * slash command runs locally; anything else is relayed verbatim.
	 */
	const interceptComposer = useCallback((text: string): boolean => {
		const route = routeComposerText(text, ctxRef.current);
		// The Composer clears its own draft right after `sendPrompt`; mirror that
		// so the palette does not linger over an empty box.
		setPaletteText("");
		setPaletteDismissed(false);
		setPaletteIndex(0);
		return route !== "passthrough";
	}, []);

	const composerClient = useMemo(() => createComposerClient(client, interceptComposer), [client, interceptComposer]);

	const query = snap.uiRequest ? null : commandQuery(paletteText);
	const matches = useMemo(() => matchCommands(query), [query]);
	const activeIndex = matches.length === 0 ? 0 : Math.min(paletteIndex, matches.length - 1);
	const paletteOpen = modal === null && query !== null && !paletteDismissed && matches.length > 0;

	const composerWrapRef = useRef<HTMLDivElement | null>(null);
	const runCommand = useCallback((name: string): void => {
		routeComposerText(`/${name}`, ctxRef.current);
		setPaletteText("");
		setPaletteDismissed(true);
		setPaletteIndex(0);
		// Commands that run off the palette never pass through the Composer's own
		// submit path, so clear its textarea here (native setter + input event,
		// which is also what re-opens palette state consistently).
		const textarea = composerWrapRef.current?.querySelector("textarea");
		if (textarea) {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, []);

	// The composer's textarea is vendored, so its value is read off the DOM: input
	// events bubble up to this wrapper.
	const onComposerInput = (e: FormEvent<HTMLDivElement>): void => {
		const target = e.target;
		if (!(target instanceof HTMLTextAreaElement)) return;
		// While a host UI request is pending the textarea is the ask editor, not a prompt draft.
		if (snap.uiRequest) return;
		setPaletteText(target.value);
		setPaletteDismissed(false);
		setPaletteIndex(0);
	};

	const onComposerKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (!paletteOpen) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				e.stopPropagation();
				setPaletteIndex((activeIndex + 1) % matches.length);
				return;
			case "ArrowUp":
				e.preventDefault();
				e.stopPropagation();
				setPaletteIndex((activeIndex - 1 + matches.length) % matches.length);
				return;
			case "Enter":
			case "Tab": {
				const spec = matches[activeIndex];
				if (!spec) return;
				e.preventDefault();
				e.stopPropagation();
				runCommand(spec.name);
				return;
			}
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				setPaletteDismissed(true);
				return;
			default:
				return;
		}
	};

	const onComposerBlur = (e: FocusEvent<HTMLDivElement>): void => {
		// Focus moving into the palette (or staying in the composer) keeps it open.
		const next = e.relatedTarget;
		if (next instanceof Node && e.currentTarget.contains(next)) return;
		setPaletteDismissed(true);
	};

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
	const closeModal = useCallback(() => setModal(null), []);
	const toasts = useMemo(
		() => (localNotices.length === 0 ? snap.notices : [...snap.notices, ...localNotices]),
		[snap.notices, localNotices],
	);

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={onLeave}
				onOpenModel={() => setModal("model")}
				onOpenThinking={() => setModal("thinking")}
				onOpenContext={() => setModal("context")}
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
			<div
				ref={composerWrapRef}
				className="hb-composer-wrap"
				onInput={onComposerInput}
				onKeyDownCapture={onComposerKeyDown}
				onBlur={onComposerBlur}
			>
				<Composer client={composerClient} snapshot={snap} />
				{paletteOpen && (
					<SlashPalette
						commands={matches}
						activeIndex={activeIndex}
						onHighlight={setPaletteIndex}
						onRun={spec => runCommand(spec.name)}
					/>
				)}
			</div>
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
			<Toasts notices={toasts} />
			{modal === "model" && <ModelPicker sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "context" && <ContextModal sessionId={sessionId} onClose={closeModal} />}
			{modal === "thinking" && <ThinkingPicker sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "rewind" && (
				<RewindPicker
					sessionId={sessionId}
					client={client}
					entries={snap.entries}
					working={snap.working}
					notify={notify}
					onClose={closeModal}
				/>
			)}
			{modal === "todos" && <TodosModal sessionId={sessionId} onClose={closeModal} />}
			{modal === "goal" && <GoalModal sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "loop" && <LoopModal sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "settings" && (
				<SettingsModal
					sessionId={sessionId}
					record={record}
					theme={{ preference: themePreference, resolved: themeResolved, setPreference: setThemePreference }}
					notify={notify}
					onClose={closeModal}
				/>
			)}
			{modal === "links" && <LinksModal record={record} onClose={closeModal} />}
			{modal === "help" && <HelpModal onClose={closeModal} />}
		</div>
	);
}
