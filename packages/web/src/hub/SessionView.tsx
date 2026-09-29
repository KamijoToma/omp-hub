/**
 * Live session surface for `/s/<id>`.
 *
 * This is the hub-side adaptation of the vendored `Session` component
 * (`src/guest/app.tsx`): it renders the shell leaves — HeaderBar, Transcript,
 * agents rail, Composer, AgentDrawer, Banners, Toasts — for one session. The
 * `GuestClient` itself is owned by the shared pool (`client-pool.ts`), so the
 * surface can remount per switch while the replica (and its transcript) stays
 * warm; page-level chrome (session rail, switcher dialog, shortcuts) lives in
 * `SessionPage`.
 *
 * On top of the shell it hosts the web slash commands (docs/protocol.md §6).
 * The vendored `Composer` stays untouched: it receives a wrapped client whose
 * `sendPrompt` routes leading-slash text through `commands.ts` instead of the
 * relay, the composer wrapper (a plain `div` around `Composer`) mirrors the
 * textarea's value to float the palette, and the command dialogs render here.
 */
import type { FocusEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "../components/agents/AgentDrawer";
import { AgentsPanel } from "../components/agents/AgentsPanel";
import { Banners } from "../components/shell/Banners";
import { Composer, isImeComposing, type ComposerDraft } from "../components/shell/Composer";
import { HeaderBar } from "../components/shell/HeaderBar";
import { StatsBar } from "../components/shell/StatsBar";
import { Toasts } from "../components/shell/Toasts";
import { Transcript } from "../components/transcript/Transcript";
import type { GuestClient } from "../lib/client";
import { useThemePreference } from "../lib/theme";
import { useTranscriptMode } from "../lib/transcript-mode";
import { useGuestSnapshot } from "../lib/use-guest";
import type { ToolRenderHost } from "../tool-render";
import type { AgentState, MachineSession, SessionRecord } from "./api";
import {
	errorText,
	formatShakeSummary,
	getMachineSessions,
	postAdvisor,
	postClearContext,
	postCompact,
	postCycle,
	postExtendedContext,
	postGenerateTitle,
	postHandoff,
	postPause,
	postPlan,
	postPrewalk,
	postRename,
	postRetry,
	postShake,
	postTier,
	startSession,
	uploadSessionFile,
} from "./api";
import type { CommandContext, CompactRequest, ModalKind, PlanRequest, PrewalkRequest } from "./commands";
import { useSessionRecord } from "./sessions-store";
import { useAgentState } from "./use-agent-state";
import {
	commandQuery,
	createComposerClient,
	dumpFileName,
	matchCommands,
	matchResumableSession,
	paletteCommandText,
	routeComposerText,
	transcriptJsonl,
} from "./commands";
import { rejoinDelayMs, shouldAutoRejoin } from "./auto-rejoin";
import { usePoolClient } from "./client-pool";
import { getComposerDraft, setComposerDraft } from "./composer-draft";
import { ContextModal } from "./ContextModal";
import { GoalModal } from "./GoalModal";
import { HelpModal } from "./HelpModal";
import { isSelfJoinNotice } from "./join-notice";
import { LinksModal } from "./LinksModal";
import { LoopModal } from "./LoopModal";
import { McpModal } from "./McpModal";
import { ModelPicker } from "./ModelPicker";
import { ResumePicker } from "./ResumePicker";
import { rewindTargetMap, rewindToEntry, RewindPicker } from "./RewindPicker";
import { navigate } from "./router";
import { SlashPalette } from "./SlashPalette";
import { SteeringQueueBar } from "./SteeringQueueBar";
import { ThinkingPicker } from "./ThinkingPicker";
import { TreePicker } from "./TreePicker";
import { useSteeringQueue } from "./steering-queue";
import { pushToast, useLocalToasts } from "./toasts";
import { TodoPanel, TODO_COLLAPSE_KEY } from "./TodoPanel";

/** Grace period before releasing the dump blob URL (some browsers start late). */
const BLOB_URL_TTL_MS = 10_000;

/** Cadence for polling `GET …/agent-state` to drive the advanced-mode header chips. */
const AGENT_STATE_POLL_MS = 5_000;

/**
 * Set a textarea's value through the native setter plus a bubbling input event:
 * React's change tracker sees a real edit, so controlled owners (the vendored
 * composer draft, the palette mirror) update as if the user typed it.
 */
function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface SessionViewProps {
	/** Hub-assigned session id (`/s/<id>`), the key for the agent-state API. */
	sessionId: string;
	/** Full (write) collab link from the session record. */
	link: string;
	/** Hub record for this session — names, links, machine. */
	record: SessionRecord | null;
	displayName: string;
	/** Polled registry status: true while the hub session is live, even if the room is mid-reconnect. */
	registryLive: boolean;
	onLeave(): void;
	/** Opens the page-level quick switcher (the `/sessions` slash command path). */
	onOpenSwitcher(): void;
	/** Opens the authenticated hub settings center with this session selected. */
	onOpenSettings(): void;
}

export function SessionView({ sessionId, link, record, displayName, registryLive, onLeave, onOpenSwitcher, onOpenSettings }: SessionViewProps): ReactNode {
	const { client, error, rejoin } = usePoolClient(sessionId, link, displayName);

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
	return (
		<Session
			client={client}
			sessionId={sessionId}
			record={record}
			displayName={displayName}
			registryLive={registryLive}
			onLeave={onLeave}
			onRejoin={rejoin}
			onOpenSwitcher={onOpenSwitcher}
			onOpenSettings={onOpenSettings}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	sessionId: string;
	record: SessionRecord | null;
	displayName: string;
	registryLive: boolean;
	onLeave(): void;
	onRejoin(): void;
	onOpenSwitcher(): void;
	onOpenSettings(): void;
}

function Session({ client, sessionId, record, displayName, registryLive, onLeave, onRejoin, onOpenSwitcher, onOpenSettings }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const transcriptMode = useTranscriptMode();
	// Handoff progress rides the registry mirror (protocol §3) through the
	// shared store's poll: the page's attach latch deliberately freezes the
	// `record` prop, so transient activity must be read from the store itself.
	const { record: mirrored } = useSessionRecord(sessionId);
	const handoffRunning = mirrored?.activity?.handoff === true;
	// Advanced session modes (protocol §2 AgentState, 0.9.0+) come from the hub
	// mirror (`GET …/agent-state`), not the collab snapshot: polled on an
	// interval while the session is live and refreshed after each command.
	const agentLoad = useAgentState(sessionId);
	const agentState = agentLoad.state;
	const agentStateRef = useRef<AgentState | null>(null);
	agentStateRef.current = agentState;
	useEffect(() => {
		if (snap.phase !== "live") return;
		const timer = setInterval(agentLoad.refresh, AGENT_STATE_POLL_MS);
		return () => clearInterval(timer);
	}, [snap.phase, agentLoad.refresh]);
	// Steering messages (TUI input-controller parity): a prompt submitted while
	// the host agent streams queues host-side and stays visible here until it
	// is delivered; an empty-editor Enter aborts so the queue delivers now.
	// Recorded texts live in the session-keyed store, so they survive switches.
	const steering = useSteeringQueue(sessionId, snap);
	const busy = snap.working || (snap.state?.isStreaming ?? false);
	const hostQueued = snap.state?.queuedMessageCount ?? 0;
	// Latest busy/steering state for the memoized composer intercept below.
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const steeringRef = useRef(steering);
	steeringRef.current = steering;
	// Host UI request mirror: while one is pending the composer's textarea is
	// the ask editor, not the prompt draft (ref keeps the rewind restore stable).
	const uiRequestRef = useRef(snap.uiRequest);
	uiRequestRef.current = snap.uiRequest;
	const composerWrapRef = useRef<HTMLDivElement | null>(null);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [modal, setModal] = useState<ModalKind | null>(null);
	// Composer text mirrored from the vendored textarea (which owns the draft
	// state). Seeded from the persisted draft so the palette matches the
	// restored buffer right after a session switch.
	const [paletteText, setPaletteText] = useState(() => getComposerDraft(sessionId).text);
	const [paletteIndex, setPaletteIndex] = useState(0);
	// Set by Esc/blur/command-run; the next keystroke brings the palette back.
	const [paletteDismissed, setPaletteDismissed] = useState(false);
	const autoOpenedRef = useRef(false);
	const { resolved: themeResolved, setPreference: setThemePreference } = useThemePreference();

	// Local notices ride the module toast store (survives surface remounts)
	// merged with the client's own notices in the vendored `Toasts` list.
	const notify = pushToast;

	const toggleTheme = useCallback((): void => {
		setThemePreference(themeResolved === "dark" ? "light" : "dark");
	}, [themeResolved, setThemePreference]);

	// `/dump`: the transcript snapshot as JSONL, handed to the browser as a download.
	const downloadDump = useCallback((): void => {
		if (snap.hasMoreHistory) {
			notify("warning", "Load all older messages before exporting the full transcript.");
			return;
		}
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
	}, [record?.name, snap.header?.title, snap.state?.sessionName, snap.entries, snap.hasMoreHistory, notify]);

	// `/compact`, `/shake`, `/handoff`, `/retry`, `/extended-context`: fire the
	// hub command, toast the outcome.
	const compactSession = useCallback(
		(request: CompactRequest): void => {
			void postCompact(sessionId, request).then(
				() => notify("info", "compaction started"),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	const shakeSession = useCallback(
		(mode: string): void => {
			void postShake(sessionId, mode).then(
				result => notify("info", formatShakeSummary(result)),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	const handoffSession = useCallback(
		(instructions?: string): void => {
			void postHandoff(sessionId, instructions).then(
				() => notify("info", "handoff started — the document lands in the transcript"),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	const clearContext = useCallback((): void => {
		void postClearContext(sessionId).then(
			dropped => notify("info", `context reset — ${dropped} message${dropped === 1 ? "" : "s"} dropped; session continues`),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	// `/new`: hub-level session orchestration (a session child cannot swap its
	// own session file without tearing down the room/links identity), so the
	// command re-starts from the current record and navigates to the new page.
	const startNewSession = useCallback((): void => {
		if (!record) {
			notify("warning", "no hub record — start new sessions from the hub home");
			return;
		}
		void startSession({ machineId: record.machineId, cwd: record.cwd, profile: record.profile }).then(
			next => {
				notify("info", "new session started");
				navigate(`/s/${next.id}`);
			},
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [record, notify]);

	// `/resume` and its picker share one start flow, the hub home's History
	// resume: a new hub session bound to the machine entry's omp session file,
	// running under the profile that owns it. Same hub-level orchestration as
	// `/new` — the current session child stays untouched.
	const resumeEntry = useCallback(
		(entry: MachineSession): void => {
			if (!record) {
				notify("warning", "no hub record — resume from the hub home");
				return;
			}
			void startSession({
				machineId: record.machineId,
				cwd: entry.cwd,
				name: entry.title || undefined,
				// The resumed session must run under the profile that owns it.
				profile: entry.profile,
				sessionFile: entry.path,
			}).then(
				next => {
					notify("info", `resumed ${entry.title || entry.id}`);
					navigate(`/s/${next.id}`);
				},
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[record, notify],
	);

	// `/resume [id]`: an argument resolves against the machine's resumable
	// sessions (TUI `resolveResumableSession` semantics) and starts it directly;
	// no argument opens the picker.
	const resumeSession = useCallback(
		(query: string): void => {
			if (!record) {
				notify("warning", "no hub record — resume from the hub home");
				return;
			}
			const needle = query.trim();
			if (!needle) {
				setModal("resume");
				return;
			}
			void getMachineSessions(record.machineId).then(
				listing => {
					const match = matchResumableSession(listing.sessions, needle);
					if (!match) {
						notify("error", `Session "${needle}" not found`);
						return;
					}
					resumeEntry(match);
				},
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[record, resumeEntry, notify],
	);

	const retrySession = useCallback((): void => {
		void postRetry(sessionId).then(
			() => notify("info", "retrying last failed turn"),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	// `/rename`: the agent-side session name is the source of truth (pinned
	// against auto-titles); the hub registry label and collab header follow.
	const renameSession = useCallback(
		(name: string): void => {
			void postRename(sessionId, name).then(
				applied => notify("info", `session renamed to "${applied}"`),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	// Bare `/rename` and the title-bar sparkles button: generate a title from
	// the conversation (TUI parity); the result pins as a user rename and the
	// registry label follows. Resolves with the applied name so the title-bar
	// button can prefill its draft, or `null` after an error notice so the
	// caller skips the success path without an unhandled rejection.
	const generateTitle = useCallback((): Promise<string | null> => {
		return postGenerateTitle(sessionId).then(
			applied => {
				notify("info", `session renamed to "${applied}"`);
				return applied;
			},
			(err: unknown) => {
				notify("error", errorText(err));
				return null;
			},
		);
	}, [sessionId, notify]);

	// Per-turn "rewind here": the transcript rows carry the target prompt; the
	// shared core (same flow as the /rewind picker) moves the host leaf and
	// truncates the replica. Latest snapshot entries ride a ref so the callback
	// identity stays stable for the memoized transcript rows.
	const entriesRef = useRef(snap.entries);
	entriesRef.current = snap.entries;
	// Rewind draft restore: put the rewound-to prompt back into the vendored
	// composer textarea (native setter + input event, like `runCommand`) so it
	// can be edited instead of retyped. Skipped while a host UI request owns
	// that textarea — it is the ask editor, not the prompt draft.
	const applyRewindDraft = useCallback((draft: string): void => {
		if (draft === "" || uiRequestRef.current) return;
		const textarea = composerWrapRef.current?.querySelector("textarea");
		if (!textarea) return;
		setNativeTextareaValue(textarea, draft);
		textarea.focus();
		textarea.setSelectionRange(draft.length, draft.length);
	}, []);
	const rewindHere = useCallback(
		(entryId: string): void => {
			if (busyRef.current) notify("warning", "rewinding interrupts the running turn");
			void rewindToEntry(sessionId, client, entriesRef.current, entryId).then(outcome => {
				if (outcome.kind === "moved") applyRewindDraft(outcome.draft);
				notify(outcome.kind === "moved" ? "info" : outcome.kind === "error" ? "error" : "warning", outcome.message);
			});
		},
		[sessionId, client, notify, applyRewindDraft],
	);

	const setExtendedContext = useCallback(
		(enabled?: boolean): void => {
			void postExtendedContext(sessionId, { enabled }).then(
				on => notify("info", `extended context ${on ? "on" : "off"}`),
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify],
	);

	// `/prewalk`, `/plan`, `/advisor`, `/fast`, `/slow`, `/pause`, `/cycle`:
	// fire the hub command, toast the outcome, and refresh the polled agent
	// state so the header chips follow immediately.
	const prewalkSession = useCallback(
		(request: PrewalkRequest): void => {
			void postPrewalk(sessionId, request).then(
				result => {
					if (request.action === "restart") {
						notify(
							result.result === "rejected" ? "warning" : "info",
							`prewalk restart ${result.result ?? "failed"}`,
						);
					} else if (result.armed === false) {
						notify("warning", "prewalk target matches the active model — nothing to arm");
					} else if (result.prewalk) {
						notify("info", `prewalk armed → ${result.prewalk.name}`);
					} else {
						notify("info", "prewalk disarmed");
					}
					agentLoad.refresh();
				},
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify, agentLoad.refresh],
	);

	const planSession = useCallback(
		(request: PlanRequest): void => {
			// Bare `/plan` toggles from the last polled plan state; unknown state
			// defaults to enabling (TUI toggle parity).
			const enabled = agentStateRef.current?.plan?.enabled === true;
			const action = request.action ?? (enabled ? "disable" : "enable");
			void postPlan(sessionId, { action, planFilePath: request.planFilePath }).then(
				plan => {
					notify(
						"info",
						plan?.enabled
							? `plan mode on${plan.workflow ? ` (${plan.workflow})` : ""} — read-only until disabled`
							: "plan mode off",
					);
					agentLoad.refresh();
				},
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify, agentLoad.refresh],
	);

	const toggleAdvisor = useCallback((): void => {
		const enabled = agentStateRef.current?.advisor?.enabled === true;
		void postAdvisor(sessionId, { action: enabled ? "disable" : "enable" }).then(
			next =>
				notify(
					"info",
					next.enabled ? `advisor on (${next.advisors.join(", ") || "discovered"})` : "advisor off",
				),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	const setTier = useCallback(
		(tier: string): void => {
			void postTier(sessionId, { action: "set", tier }).then(
				tiers => {
					const applied = Object.entries(tiers)
						.map(([family, value]) => `${family}=${value}`)
						.join(", ");
					notify("info", applied ? `service tier set — ${applied}` : `service tier ${tier} applied`);
					agentLoad.refresh();
				},
				(err: unknown) => notify("error", errorText(err)),
			);
		},
		[sessionId, notify, agentLoad.refresh],
	);

	const togglePause = useCallback((): void => {
		void postPause(sessionId, {}).then(
			paused => notify("info", paused ? "session paused — /pause resumes" : "session resumed"),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	const cycleModel = useCallback((): void => {
		void postCycle(sessionId, { direction: "forward" }).then(
			result =>
				notify(
					result.switched && result.model ? "info" : "warning",
					result.switched && result.model
						? `switched to ${result.model.name}${result.thinkingLevel ? ` · ${result.thinkingLevel}` : ""}`
						: "nothing to cycle to",
				),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	// TUI ctrl+p parity: cycle the configured role models (cycleOrder — default
	// smol → default → slow) instead of the model list; 0.10.0+ agents only.
	const cycleRoles = useCallback((): void => {
		void postCycle(sessionId, { direction: "forward", roleCycle: true }).then(
			result =>
				notify(
					result.switched && result.model ? "info" : "warning",
					result.switched && result.model
						? `switched to ${result.model.name}${result.thinkingLevel ? ` · ${result.thinkingLevel}` : ""}`
						: "no role cycle — assign models to smol/default/slow first",
				),
			(err: unknown) => notify("error", errorText(err)),
		);
	}, [sessionId, notify]);

	// `/todo`: the todo board lives in the docked panel (derived from the live
	// transcript), so the command only guarantees it is expanded.
	const [todoOpen, setTodoOpen] = useState(() => localStorage.getItem(TODO_COLLAPSE_KEY) !== "1");
	const showTodos = useCallback((): void => {
		if (!todoOpen) notify("info", "todo list shown above the composer");
		setTodoOpen(true);
	}, [todoOpen, notify]);

	// Latest command context, so the long-lived composer wrapper never sees a stale one.
	const ctx: CommandContext = {
		// Session switching and settings live in the persistent page frame.
		openModal: kind => {
			if (kind === "sessions") onOpenSwitcher();
			else if (kind === "settings") {
				setPaletteDismissed(true);
				onOpenSettings();
			} else setModal(kind);
		},
		toggleTheme,
		navigate,
		downloadDump,
		notify,
		compactSession,
		shakeSession,
		handoffSession,
		clearContext,
		startNewSession,
		resumeSession,
		retrySession,
		renameSession,
		generateTitle,
		setExtendedContext,
		prewalkSession,
		planSession,
		toggleAdvisor,
		setTier,
		togglePause,
		cycleModel,
		cycleRoles,
		showTodos,
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
		// A prompt handed to the host while it streams is queued as a steering
		// message; record it so the queue bar can show the text until delivery.
		if (route === "passthrough" && busyRef.current) steeringRef.current.recordQueued(text);
		return route !== "passthrough";
	}, []);

	/** Empty-editor Enter and the queue bar's button: abort the turn; the host drains the queue into the next one. */
	const flushSteering = useCallback((): void => {
		if (!busyRef.current) return;
		client.sendAbort();
		notify("info", "interrupting — the queued messages deliver now");
	}, [client, notify]);

	// Persist the unsent composer buffer per session: switching sessions
	// remounts the vendored Composer, which would start empty without the seed.
	const onDraftChange = useCallback(
		(draft: ComposerDraft): void => setComposerDraft(sessionId, draft),
		[sessionId],
	);

	const composerClient = useMemo(() => createComposerClient(client, interceptComposer), [client, interceptComposer]);

	const query = snap.uiRequest ? null : commandQuery(paletteText);
	const matches = useMemo(() => matchCommands(query), [query]);
	const activeIndex = matches.length === 0 ? 0 : Math.min(paletteIndex, matches.length - 1);
	const paletteOpen = modal === null && query !== null && !paletteDismissed && matches.length > 0;

	const runCommand = useCallback((name: string): void => {
		// The vendored textarea's live value carries the typed args; completing
		// off the palette must not drop them (e.g. `/rename my title`).
		const draft = composerWrapRef.current?.querySelector("textarea")?.value ?? "";
		routeComposerText(paletteCommandText(draft, name), ctxRef.current);
		setPaletteText("");
		setPaletteDismissed(true);
		setPaletteIndex(0);
		// Commands that run off the palette never pass through the Composer's own
		// submit path, so clear its textarea here (native setter + input event,
		// which is also what re-opens palette state consistently).
		const textarea = composerWrapRef.current?.querySelector("textarea");
		if (textarea) setNativeTextareaValue(textarea, "");
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

	const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		// TUI parity: Enter on an empty editor while the agent runs and messages
		// are queued aborts the turn so the host delivers the queue immediately.
		// Capture phase keeps the vendored textarea from seeing the key.
		if (
			e.key === "Enter" &&
			!e.shiftKey &&
			!e.nativeEvent.isComposing &&
			!snap.uiRequest &&
			busy &&
			snap.phase === "live" &&
			!snap.readOnly &&
			!paletteText.trim() &&
			(steering.pending.length > 0 || hostQueued > 0)
		) {
			e.preventDefault();
			e.stopPropagation();
			flushSteering();
			return;
		}
		// IME composition keys (candidate confirm/nav/cancel) must not drive the palette.
		if (isImeComposing(e)) return;
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

	// Read-only links never offer the per-turn rewind affordance.
	const rewind = useMemo(() => {
		if (snap.readOnly) return undefined;
		return { targets: rewindTargetMap(snap.entries), onRewind: rewindHere };
	}, [snap.readOnly, snap.entries, rewindHere]);

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

	// Auto-rejoin while the registry still says live: a fatal-looking relay
	// close ("no such room" right after a hub restart, host mid-reconnect) is
	// transient in the hub — the room returns. Retry with backoff; a registry
	// flip to exited/failed stops the loop and restores the end card.
	const [rejoinAttempt, setRejoinAttempt] = useState(0);
	useEffect(() => {
		if (!shouldAutoRejoin(snap.phase, registryLive)) return;
		const timer = setTimeout(() => {
			setRejoinAttempt(attempt => attempt + 1);
			onRejoin();
		}, rejoinDelayMs(rejoinAttempt));
		return () => clearTimeout(timer);
	}, [snap.phase, registryLive, rejoinAttempt, onRejoin]);
	useEffect(() => {
		// Backoff resets only on a real reconnect (phase left the ended cycle).
		if (snap.phase === "live") setRejoinAttempt(0);
	}, [snap.phase]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const closeModal = useCallback(() => setModal(null), []);
	const localToasts = useLocalToasts();
	const toasts = useMemo(() => {
		// The host echoes every guest join into the room; our own join is what
		// switching to a session is, so it never surfaces as a toast.
		const notices = snap.notices.filter(n => !isSelfJoinNotice(n.message, displayName));
		return localToasts.length === 0 ? notices : [...notices, ...localToasts];
	}, [snap.notices, localToasts, displayName]);

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
				onRename={renameSession}
				onGenerateTitle={generateTitle}
				handoffRunning={handoffRunning}
				prewalkTarget={agentState?.prewalk?.name}
				planEnabled={agentState?.plan?.enabled === true}
				advisorEnabled={agentState?.advisor?.enabled === true}
				paused={agentState?.paused === true}
			/>
			{transcriptMode === "full" && <StatsBar snapshot={snap} />}
			<main className="sh-main">
				<section className="sh-content">
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							hasMoreHistory={snap.hasMoreHistory}
							historyLoading={snap.historyLoading}
							historyError={snap.historyError}
							onLoadOlder={() => client.loadOlder()}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							rewind={rewind}
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
				<TodoPanel entries={snap.entries} open={todoOpen} onToggle={() => setTodoOpen(prev => !prev)} />
				<SteeringQueueBar pending={steering.pending} extraQueued={steering.extraQueued} onFlush={flushSteering} />
				<Composer
					client={composerClient}
					snapshot={snap}
					uploadFile={file => uploadSessionFile(sessionId, file)}
					initialDraft={getComposerDraft(sessionId)}
					onDraftChange={onDraftChange}
				/>
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
			{/* The registry still owns truth: ended + live reads as a reconnect, not an end. */}
			<Banners
				phase={shouldAutoRejoin(snap.phase, registryLive) ? "reconnecting" : snap.phase}
				endedReason={snap.endedReason}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
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
					onDraft={applyRewindDraft}
					onClose={closeModal}
				/>
			)}
			{modal === "tree" && (
				<TreePicker sessionId={sessionId} onResync={onRejoin} notify={notify} onClose={closeModal} />
			)}
			{modal === "resume" && record && (
				<ResumePicker machineId={record.machineId} onResume={resumeEntry} onClose={closeModal} />
			)}
			{modal === "goal" && <GoalModal sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "mcp" && <McpModal sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "loop" && <LoopModal sessionId={sessionId} notify={notify} onClose={closeModal} />}
			{modal === "links" && <LinksModal record={record} onClose={closeModal} />}
			{modal === "help" && <HelpModal onClose={closeModal} />}
		</div>
	);
}
