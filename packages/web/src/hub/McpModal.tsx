/**
 * `/mcp` — manage the session's MCP servers (TUI `/mcp` ACP parity). The
 * listing is the agent's `mcp-list` reply: redacted config rows joined with
 * the live session's view, so a row can be configured-but-not-yet-loaded —
 * config edits apply to new sessions, `health` shows what this session
 * actually mounted. Actions POST add/remove/enabled/test; the agent's own
 * validation and writer errors surface as notices.
 */
import { LoaderCircle, PlugZap, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Notice } from "../lib/client";
import type { McpServerInfo } from "./api";
import { errorText, getMcpServers, postMcpAdd, postMcpEnabled, postMcpRemove, postMcpTest } from "./api";
import { Modal } from "./Modal";

export interface McpModalProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onClose(): void;
}

export function McpModal({ sessionId, notify, onClose }: McpModalProps): ReactNode {
	const [servers, setServers] = useState<McpServerInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	/** Bumped after every mutation; the effect re-lists when it changes. */
	const [reload, setReload] = useState(0);

	useEffect(() => {
		let alive = true;
		void getMcpServers(sessionId).then(
			rows => {
				if (!alive) return;
				setServers(rows);
				setError(null);
			},
			(err: unknown) => {
				if (!alive) return;
				setServers(null);
				setError(errorText(err));
			},
		);
		return () => {
			alive = false;
		};
	}, [sessionId, reload]);

	const refresh = (): void => setReload(value => value + 1);

	const act = (key: string, run: () => Promise<string>): void => {
		setPendingAction(key);
		void run().then(
			message => {
				setPendingAction(null);
				notify("info", message);
				refresh();
			},
			(err: unknown) => {
				setPendingAction(null);
				notify("error", errorText(err));
			},
		);
	};

	return (
		<Modal title="MCP servers" onClose={onClose}>
			<div className="hb-modal-section">
				{servers === null && error === null && (
					<p className="hb-busy">
						<LoaderCircle size={13} className="hb-spin" aria-hidden="true" /> loading servers…
					</p>
				)}
				{error !== null && (
					<div className="hb-modal-error" role="alert">
						{error}
					</div>
				)}
				{servers !== null && servers.length === 0 && <p className="hb-empty">no MCP servers configured</p>}
				{servers !== null && servers.length > 0 && (
					<ul className="hb-mcp-list">
						{servers.map(server => (
							<McpRow
								key={`${server.scope}:${server.name}`}
								server={server}
								sessionId={sessionId}
								pendingAction={pendingAction}
								act={act}
								refresh={refresh}
							/>
						))}
					</ul>
				)}
			</div>

			<div className="hb-ops-actions">
				<button type="button" className="sh-btn" onClick={() => setShowAdd(value => !value)} disabled={pendingAction !== null}>
					<Plus size={12} aria-hidden="true" />
					<span className="sh-btn-label">Add server</span>
				</button>
				{pendingAction !== null && <LoaderCircle size={13} className="hb-spin" aria-label="working" />}
			</div>
			{showAdd && (
				<McpAddForm
					sessionId={sessionId}
					notify={notify}
					onDone={() => {
						setShowAdd(false);
						refresh();
					}}
				/>
			)}
			<p className="hb-card-note">
				Config changes apply to new sessions; restart the session to reload tools. `health` shows what this session
				mounted at start.
			</p>
		</Modal>
	);
}

interface McpRowProps {
	server: McpServerInfo;
	sessionId: string;
	pendingAction: string | null;
	act(key: string, run: () => Promise<string>): void;
	refresh(): void;
}

function McpRow({ server, sessionId, pendingAction, act, refresh }: McpRowProps): ReactNode {
	const [showTools, setShowTools] = useState(false);
	const [testResult, setTestResult] = useState<string | null>(null);
	const key = `${server.scope}:${server.name}`;
	const busy = pendingAction !== null;

	const healthLabel = server.shadowed ? "shadowed" : server.enabled ? (server.health ?? "not loaded") : "disabled";
	return (
		<li className="hb-mcp-row">
			<div className="hb-mcp-row-head">
				<span className="hb-mcp-name">{server.name}</span>
				<span className={`hb-mcp-badge hb-mcp-${server.shadowed ? "shadowed" : server.enabled ? (server.health ?? "off") : "disabled"}`}>
					{healthLabel}
				</span>
				<span className="hb-mcp-meta">
					{server.type} · {server.scope}
					{server.envCount > 0 ? ` · ${server.envCount} env` : ""}
				</span>
			</div>
			{server.location && <div className="hb-mcp-location">{server.location}</div>}
			{server.implementationName && (
				<div className="hb-mcp-meta">
					{server.implementationName}
					{server.implementationVersion ? ` ${server.implementationVersion}` : ""}
				</div>
			)}
			{server.toolsCount !== undefined && (
				<button type="button" className="sh-btn hb-mcp-tools-toggle" onClick={() => setShowTools(value => !value)}>
					{server.toolsCount} tool{server.toolsCount === 1 ? "" : "s"}
					{showTools ? " ▲" : " ▼"}
				</button>
			)}
			{showTools && server.tools !== undefined && server.tools.length > 0 && (
				<ul className="hb-mcp-tools">
					{server.tools.map(tool => (
						<li key={tool.name} title={tool.description}>
							{tool.name}
						</li>
					))}
				</ul>
			)}
			{testResult && <div className="hb-mcp-test">{testResult}</div>}
			<div className="hb-mcp-actions">
				<button
					type="button"
					className="sh-btn"
					disabled={busy || server.shadowed}
					title={server.shadowed ? "shadowed by the same-name entry in the other scope" : undefined}
					onClick={() =>
						act(`${key}:test`, async () => {
							const result = await postMcpTest(sessionId, server.name);
							const summary = `${result.name}: connected, ${result.count} tool${result.count === 1 ? "" : "s"}`;
							setTestResult(summary + (result.tools.length > 0 ? ` — ${result.tools.map(tool => tool.name).join(", ")}` : ""));
							refresh();
							return summary;
						})
					}
				>
					<PlugZap size={12} aria-hidden="true" />
					<span className="sh-btn-label">Test</span>
				</button>
				<button
					type="button"
					className="sh-btn"
					disabled={busy}
					onClick={() =>
						act(`${key}:toggle`, async () => {
							const next = !server.enabled;
							const result = await postMcpEnabled(sessionId, server.name, next);
							return `server "${result.name}" ${result.enabled ? "enabled" : "disabled"} (${result.where})`;
						})
					}
				>
					<span className="sh-btn-label">{server.enabled ? "Disable" : "Enable"}</span>
				</button>
				<button
					type="button"
					className="sh-btn"
					disabled={busy}
					title={`remove from ${server.scope} config`}
					onClick={() => {
						if (!window.confirm(`Remove "${server.name}" from the ${server.scope} config?`)) return;
						act(`${key}:remove`, async () => {
							await postMcpRemove(sessionId, server.name, server.scope);
							return `removed "${server.name}" from ${server.scope} config`;
						});
					}}
				>
					<Trash2 size={12} aria-hidden="true" />
					<span className="sh-btn-label">Remove</span>
				</button>
			</div>
		</li>
	);
}

interface McpAddFormProps {
	sessionId: string;
	notify(level: Notice["level"], message: string): void;
	onDone(): void;
}

/** Add form mirroring the agent's `mcp-add` inputs: stdio command or remote URL, project or user scope. */
function McpAddForm({ sessionId, notify, onDone }: McpAddFormProps): ReactNode {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"stdio" | "remote">("remote");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [url, setUrl] = useState("");
	const [transport, setTransport] = useState<"http" | "sse">("http");
	const [token, setToken] = useState("");
	const [scope, setScope] = useState<"project" | "user">("project");
	const [pending, setPending] = useState(false);

	const valid = name.trim() !== "" && (kind === "stdio" ? command.trim() !== "" : url.trim() !== "");

	const submit = (): void => {
		if (!valid || pending) return;
		setPending(true);
		void postMcpAdd(sessionId, {
			name: name.trim(),
			scope,
			...(kind === "stdio"
				? { command: command.trim(), ...(args.trim() ? { args: args.trim().split(/\s+/) } : {}) }
				: { url: url.trim(), transport, ...(token.trim() ? { token: token.trim() } : {}) }),
		}).then(
			added => {
				setPending(false);
				notify("info", `added "${added.name}" to ${added.scope} config — applies to new sessions`);
				onDone();
			},
			(err: unknown) => {
				setPending(false);
				notify("error", errorText(err));
			},
		);
	};

	return (
		<form
			className="hb-modal-section hb-mcp-add"
			onSubmit={event => {
				event.preventDefault();
				submit();
			}}
		>
			<input
				className="sh-input"
				value={name}
				onChange={e => setName(e.target.value)}
				placeholder="server name (letters, numbers, - _ . :)"
				spellCheck={false}
				autoComplete="off"
				aria-label="server name"
			/>
			<div className="hb-mcp-kind">
				<label>
					<input type="radio" name="mcp-kind" checked={kind === "remote"} onChange={() => setKind("remote")} /> remote
					(URL)
				</label>
				<label>
					<input type="radio" name="mcp-kind" checked={kind === "stdio"} onChange={() => setKind("stdio")} /> stdio
					(command)
				</label>
			</div>
			{kind === "remote" ? (
				<>
					<input
						className="sh-input"
						value={url}
						onChange={e => setUrl(e.target.value)}
						placeholder="https://mcp.example.dev/endpoint"
						spellCheck={false}
						autoComplete="off"
						aria-label="server url"
					/>
					<div className="hb-mcp-kind">
						<label>
							<input type="radio" name="mcp-transport" checked={transport === "http"} onChange={() => setTransport("http")} />{" "}
							http
						</label>
						<label>
							<input type="radio" name="mcp-transport" checked={transport === "sse"} onChange={() => setTransport("sse")} /> sse
						</label>
						<input
							className="sh-input"
							value={token}
							onChange={e => setToken(e.target.value)}
							placeholder="bearer token (optional)"
							type="password"
							autoComplete="off"
							aria-label="bearer token"
						/>
					</div>
				</>
			) : (
				<>
					<input
						className="sh-input"
						value={command}
						onChange={e => setCommand(e.target.value)}
						placeholder="command (e.g. bun)"
						spellCheck={false}
						autoComplete="off"
						aria-label="stdio command"
					/>
					<input
						className="sh-input"
						value={args}
						onChange={e => setArgs(e.target.value)}
						placeholder="arguments, space-separated (optional)"
						spellCheck={false}
						autoComplete="off"
						aria-label="stdio arguments"
					/>
				</>
			)}
			<div className="hb-mcp-kind">
				<label>
					<input type="radio" name="mcp-scope" checked={scope === "project"} onChange={() => setScope("project")} /> project
					config
				</label>
				<label>
					<input type="radio" name="mcp-scope" checked={scope === "user"} onChange={() => setScope("user")} /> user config
				</label>
			</div>
			<div className="hb-ops-actions">
				<button type="submit" className="sh-btn" disabled={!valid || pending}>
					{pending ? <LoaderCircle size={12} className="hb-spin" aria-hidden="true" /> : null}
					<span className="sh-btn-label">Add</span>
				</button>
			</div>
		</form>
	);
}
