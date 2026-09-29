import type {
	AssistantMessage,
	ImageContent,
	SessionEntry,
	TextContent,
	ToolResultMessage,
} from "../../lib/wire";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../../lib/wire";
import { ChevronRight, History } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool } from "../../lib/client";
import { fmtDuration, fmtTokens } from "../../lib/format";
import { fmtUsageCost, outputTokensPerSecond, usageDetail } from "../../lib/usage";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

/** Optional per-turn "rewind here" affordance; `targets` maps entry id → its turn prompt id. */
export interface TranscriptRewind {
	targets: ReadonlyMap<string, string>;
	onRewind(entryId: string): void;
}

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	hasMoreHistory?: boolean;
	historyLoading?: boolean;
	historyError?: string | null;
	onLoadOlder?: () => void;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** When present, message rows show a hover/tap "rewind here" button. */
	rewind?: TranscriptRewind;
}

// ═══════════════════════════════════════════════════════════════════════════
// Turn grouping
//
// The flat entry list is clustered into conversation turns before rendering:
// a user prompt (own accent bubble) and the agent work run it triggered
// (one raised card holding every assistant request of that run). Meta entries
// — dividers, standalone markers, displayed custom messages — stay ungrouped.
// ═══════════════════════════════════════════════════════════════════════════

type AgentTurn = {
	kind: "agent";
	key: string;
	entries: SessionEntry[];
	/** Streaming ghost continuing this turn. */
	ghost: AssistantMessage | null;
	ghostPending: boolean;
	/** Active tools not represented inside `ghost`. */
	tailTools: ActiveTool[];
	/** Nothing visible yet — bare "thinking…" pulse. */
	shimmer: boolean;
	/** Turn is still producing output. */
	live: boolean;
};

type TurnGroup =
	| { kind: "user"; key: string; entry: SessionEntry; from: string | null; synthetic: boolean }
	| AgentTurn
	| { kind: "custom"; key: string; entry: SessionEntry }
	| { kind: "divider"; key: string; entry: SessionEntry }
	| { kind: "marker"; key: string; entry: SessionEntry };

/** Sender shown on a collab guest prompt bubble; `from` falls back to "guest". */
function collabGuestName(entry: SessionEntry): string | null {
	if (entry.type !== "custom_message") return null;
	const details = entry.details;
	if (details === null || typeof details !== "object") return "guest";
	const from = (details as Record<string, unknown>).from;
	return typeof from === "string" && from.length > 0 ? from : "guest";
}

/** Local `hh:mm` for a card header; null when the timestamp is unparseable. */
function fmtClock(timestamp: string): string | null {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return null;
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function agentModel(group: AgentTurn): string | null {
	for (const entry of group.entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			return entry.message.model;
		}
	}
	return group.ghost !== null ? group.ghost.model : null;
}

function buildTurnGroups(model: {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
}): TurnGroup[] {
	const { entries, stream, streamDone, activeTools, working } = model;

	// Active tools not already represented as toolCall blocks in the stream ghost.
	const streamIds = new Set<string>();
	if (stream !== null) {
		for (const block of stream.content) {
			if (block.type === "toolCall") streamIds.add(block.id);
		}
	}
	const tailTools: ActiveTool[] = [];
	for (const tool of activeTools.values()) {
		if (!streamIds.has(tool.toolCallId)) tailTools.push(tool);
	}

	const groups: TurnGroup[] = [];
	let agent: AgentTurn | null = null;
	const openAgent = (): AgentTurn => {
		const turn: AgentTurn = {
			kind: "agent",
			key: `agent-${groups.length}`,
			entries: [],
			ghost: null,
			ghostPending: false,
			tailTools: [],
			shimmer: false,
			live: false,
		};
		groups.push(turn);
		return turn;
	};

	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				if (msg.role === "assistant") {
					if (agent === null) agent = openAgent();
					agent.entries.push(entry);
				} else if (msg.role === "user") {
					if (msg.synthetic === true && agent !== null) {
						// System-injected prompt (steering / auto-continue) mid-run:
						// an inline row inside the running turn, not a new bubble.
						agent.entries.push(entry);
					} else {
						agent = null;
						groups.push({
							kind: "user",
							key: `user-${groups.length}`,
							entry,
							from: null,
							synthetic: msg.synthetic === true,
						});
					}
				}
				// toolResult entries are consumed via pairing; developer & unknown roles skipped
				break;
			}
			case "custom_message": {
				if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
					agent = null;
					groups.push({
						kind: "user",
						key: `user-${groups.length}`,
						entry,
						from: collabGuestName(entry),
						synthetic: false,
					});
				} else if (entry.display) {
					agent = null;
					groups.push({ kind: "custom", key: `custom-${groups.length}`, entry });
				}
				break;
			}
			case "compaction":
			case "branch_summary":
				agent = null;
				groups.push({ kind: "divider", key: `divider-${groups.length}`, entry });
				break;
			case "model_change":
			case "thinking_level_change":
				// Mid-run setting changes ride along inside the open agent turn.
				if (agent !== null) agent.entries.push(entry);
				else groups.push({ kind: "marker", key: `marker-${groups.length}`, entry });
				break;
			default:
				break; // unknown entry types from newer hosts — skip tolerantly
		}
	}

	// The live tail — stream ghost, active tools, "thinking…" — extends the
	// trailing agent turn, or opens one when the transcript ends on something else.
	if (stream !== null || tailTools.length > 0 || working) {
		const last = groups.at(-1);
		const turn = last !== undefined && last.kind === "agent" ? last : openAgent();
		if (stream !== null) {
			turn.ghost = stream;
			turn.ghostPending = !streamDone;
		}
		turn.tailTools = tailTools;
		turn.shimmer = stream === null && tailTools.length === 0 && working;
		turn.live = (stream !== null && !streamDone) || working;
	}

	return groups;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════

/** One message row inside a turn card; hover/tap affordance pinned top-right. */
function Msg({
	kind,
	synthetic,
	title,
	action,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	synthetic?: boolean;
	title?: string;
	action?: ReactNode;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-msg tr-msg--${kind}${synthetic === true ? " tr-msg--synthetic" : ""}`} title={title}>
			{synthetic === true && <span className="tr-turn-tag">auto</span>}
			{children}
			{action}
		</div>
	);
}

/** Per-turn rewind affordance: hidden until row hover on pointers, always visible on touch. */
function RewindButton({ onRewind }: { onRewind(): void }): ReactNode {
	return (
		<button type="button" className="tr-rewind" title="rewind to this turn" onClick={onRewind}>
			<History size={12} aria-hidden="true" />
		</button>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Plain text + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <div className="tr-text">{content}</div>;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return (
							<div key={i} className="tr-text">
								{block.text}
							</div>
						);
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

/**
 * Per-message usage for a finished assistant turn: a one-line summary that
 * expands into the metrics plus the host-reported request timing (TTFT and
 * the whole-request output rate, same figures as the TUI usage row). Costs
 * are estimated (provider price tables applied to the reported tokens), so
 * they carry an `≈`/`est.` marker, and a metric the host never reported stays
 * "—" instead of reading as a real zero.
 */
function UsageSummary({ message }: { message: AssistantMessage }): ReactNode {
	const [open, setOpen] = useState(false);
	const detail = usageDetail(message.usage, message);
	if (detail === null) {
		return (
			<div className="tr-usage tr-usage-none" title="the host sent no usage block for this message">
				usage unavailable
			</div>
		);
	}
	const tps = outputTokensPerSecond(detail);
	const summary: string[] = [];
	if (detail.totalTokens !== null) summary.push(`${fmtTokens(detail.totalTokens)} tok`);
	else {
		if (detail.input !== null) summary.push(`in ${fmtTokens(detail.input)}`);
		if (detail.output !== null) summary.push(`out ${fmtTokens(detail.output)}`);
	}
	if (detail.cost !== null) summary.push(`≈${fmtUsageCost(detail.cost)}`);
	if (tps !== null) summary.push(`${tps.toFixed(1)} tok/s`);
	const rows: readonly { key: string; label: string; value: ReactNode }[] = [
		{ key: "input", label: "input", value: detail.input === null ? "—" : fmtTokens(detail.input) },
		{ key: "output", label: "output", value: detail.output === null ? "—" : fmtTokens(detail.output) },
		{ key: "cacheRead", label: "cache read", value: detail.cacheRead === null ? "—" : fmtTokens(detail.cacheRead) },
		{
			key: "cacheWrite",
			label: "cache write",
			value: detail.cacheWrite === null ? "—" : fmtTokens(detail.cacheWrite),
		},
		{
			key: "cost",
			label: "cost",
			value:
				detail.cost === null ? (
					"—"
				) : (
					<>
						≈{fmtUsageCost(detail.cost)}
						<span className="tr-usage-est" title="estimate: provider price tables applied to the reported tokens">
							est.
						</span>
					</>
				),
		},
		{ key: "ttft", label: "ttft", value: detail.ttftMs === null ? "—" : fmtDuration(detail.ttftMs) },
		{
			key: "tokPerSec",
			label: "output rate",
			value:
				tps === null ? (
					"—"
				) : (
					<span title="output tokens over the whole request window">{tps.toFixed(1)}/s</span>
				),
		},
	];
	return (
		<div className="tr-usage">
			<button
				type="button"
				className="tr-usage-head"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				title="usage for this message — tokens as reported, cost estimated from provider price tables, timing from the host's request clock"
			>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} aria-hidden="true" />
				<span className="tr-usage-summary">{summary.length > 0 ? summary.join(" · ") : "usage"}</span>
				<span className="tr-usage-toggle">{open ? "hide" : "detail"}</span>
			</button>
			{open && (
				<dl className="tr-usage-grid">
					{rows.map(row => (
						<div className="tr-usage-row" key={row.key}>
							<dt className="tr-usage-label">{row.label}</dt>
							<dd className="tr-usage-value">{row.value}</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={block.arguments}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
			{/* Streaming ghosts carry accumulating usage: only a finished turn may show it. */}
			{!pending && <UsageSummary message={message} />}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	/** Id of the turn prompt this row rewinds to; absent before the first prompt. */
	rewindTargetId?: string;
	onRewindEntry?: (entryId: string) => void;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	if (prev.rewindTargetId !== next.rewindTargetId || prev.onRewindEntry !== next.onRewindEntry) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({
	entry,
	results,
	active,
	host,
	rewindTargetId,
	onRewindEntry,
}: EntryRowProps): ReactNode {
	const action =
		rewindTargetId !== undefined && onRewindEntry !== undefined ? (
			<RewindButton onRewind={() => onRewindEntry(rewindTargetId)} />
		) : undefined;
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Msg kind="user" synthetic={msg.synthetic === true} title={entry.timestamp} action={action}>
							<MsgContent content={msg.content} />
						</Msg>
					);
				case "assistant":
					return (
						<Msg kind="assistant" title={entry.timestamp} action={action}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Msg>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
				// Sender name lives on the wrapping user card's header.
				return (
					<Msg kind="user" title={entry.timestamp} action={action}>
						<MsgContent content={entry.content} />
					</Msg>
				);
			}
			if (!entry.display) return null;
			return (
				<Msg kind="custom" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Msg>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>
						context compacted{entry.method ? ` (${entry.method})` : ""} ·{" "}
						{entry.tokensAfter !== undefined
							? `${fmtTokens(entry.tokensBefore)} → ${fmtTokens(entry.tokensAfter)} tokens`
							: `${fmtTokens(entry.tokensBefore)} tokens`}
					</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Msg kind="marker" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Msg>
			);
		case "thinking_level_change":
			return (
				<Msg kind="marker" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Msg>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/** Renders one clustered turn: cards for user/agent turns, bare rows for meta. */
function TurnGroupView({
	group,
	results,
	active,
	host,
	rewind,
}: {
	group: TurnGroup;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	rewind?: TranscriptRewind;
}): ReactNode {
	const entryRow = (entry: SessionEntry): ReactNode => (
		<EntryRow
			entry={entry}
			results={results}
			active={active}
			host={host}
			rewindTargetId={rewind?.targets.get(entry.id)}
			onRewindEntry={rewind?.onRewind}
		/>
	);
	switch (group.kind) {
		case "user": {
			const clock = fmtClock(group.entry.timestamp);
			return (
				<div
					className={`tr-turn tr-turn--user${group.synthetic ? " tr-turn--synthetic" : ""}`}
					title={group.entry.timestamp}
				>
					{(group.from !== null || group.synthetic || clock !== null) && (
						<header className="tr-turn-head">
							{group.from !== null && <span className="tr-turn-name">{group.from}</span>}
							{group.synthetic && <span className="tr-turn-tag">auto</span>}
							{clock !== null && <span className="tr-turn-time">{clock}</span>}
						</header>
					)}
					{entryRow(group.entry)}
				</div>
			);
		}
		case "agent": {
			// Header model chip: provider prefix stripped (`anthropic/x` → `x`).
			const rawModel = agentModel(group);
			const model =
				rawModel === null
					? null
					: (rawModel
							.split("/")
							.filter(part => part.length > 0)
							.pop() ?? rawModel);
			const first = group.entries[0];
			const clock = first === undefined ? null : fmtClock(first.timestamp);
			return (
				<div className={`tr-turn tr-turn--agent${group.live ? " tr-turn--live" : ""}`}>
					<header className="tr-turn-head">
						<span className="tr-turn-dot" aria-hidden="true" />
						{model !== null && <span className="tr-turn-model">{model}</span>}
						{first !== undefined && clock !== null && (
							<span className="tr-turn-time" title={first.timestamp}>
								{clock}
							</span>
						)}
					</header>
					{group.entries.map(entry => (
						<EntryRow
							key={entry.id}
							entry={entry}
							results={results}
							active={active}
							host={host}
							rewindTargetId={rewind?.targets.get(entry.id)}
							onRewindEntry={rewind?.onRewind}
						/>
					))}
					{group.ghost !== null && (
						<Msg kind="assistant">
							<AssistantBody
								message={group.ghost}
								results={results}
								active={active}
								pending={group.ghostPending}
								host={host}
							/>
						</Msg>
					)}
					{group.tailTools.map(tool => (
						<Msg key={tool.toolCallId} kind="assistant">
							<ToolCard
								toolCallId={tool.toolCallId}
								name={tool.toolName}
								intent={tool.intent}
								args={tool.args}
								running
								partialResult={tool.partialResult}
								host={host}
							/>
						</Msg>
					))}
					{group.shimmer && (
						<Msg kind="assistant">
							<div className="tr-shimmer">thinking…</div>
						</Msg>
					)}
				</div>
			);
		}
		case "custom":
		case "divider":
		case "marker":
			return entryRow(group.entry);
	}
}

export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries, stream, streamDone, activeTools, working, compact, host, rewind,
		hasMoreHistory, historyLoading, historyError, onLoadOlder,
	} = props;

	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);

	const groups = useMemo(
		() => buildTurnGroups({ entries, stream, streamDone, activeTools, working }),
		[entries, stream, streamDone, activeTools, working],
	);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	const anchorRef = useRef<{ firstId: string; height: number; top: number } | null>(null);
	const requestOlder = (): void => {
		const el = rootRef.current;
		if (!el || !entries[0] || !hasMoreHistory || historyLoading || !onLoadOlder) return;
		anchorRef.current = { firstId: entries[0].id, height: el.scrollHeight, top: el.scrollTop };
		lockRef.current = false;
		onLoadOlder();
	};

	useLayoutEffect(() => {
		const anchor = anchorRef.current;
		const el = rootRef.current;
		if (!anchor || !el) return;
		if (entries[0]?.id !== anchor.firstId) {
			el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
			anchorRef.current = null;
		} else if (!historyLoading) {
			anchorRef.current = null;
		}
	}, [entries, historyLoading]);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && lockRef.current) el.scrollTop = el.scrollHeight;
	}, [entries, stream, activeTools, working]);

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el !== null) {
					lockRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
					if (el.scrollTop <= 120 && !historyError) requestOlder();
				}
			}}
		>
			{hasMoreHistory && (
				<button type="button" className="tr-history" disabled={historyLoading} onClick={requestOlder}>
					{historyLoading ? "loading older messages…" : historyError ?? "load older messages"}
				</button>
			)}
			{groups.length === 0 && <div className="tr-empty">no activity yet</div>}
			{groups.map(group => (
				<TurnGroupView
					key={group.key}
					group={group}
					results={results}
					active={activeTools}
					host={host}
					rewind={rewind}
				/>
			))}
		</div>
	);
}
