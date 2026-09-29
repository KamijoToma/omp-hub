/**
 * Friendly parsing of tool `path` arguments: omp internal URL schemes
 * (`proc://`, `xd://`, `agent://`, `artifact://`, `history://`, `local://`,
 * `cfg://`, `ssh://`, `issue://`, `pr://`, `mcp://`, `omp://`, `memory://`),
 * web URLs, SQLite `file.db:table[:key]?query` targets and archive
 * `archive.ext:member` selectors.
 *
 * Pure and host-agnostic (also bundled into the `<omp-tool-view>` export web
 * component). Mirrors the omp SDK internal-URL grammar closely enough for
 * display; this module is never consulted for access decisions.
 */
import { shortenPath } from "./util";

export type PathKind =
	| "file"
	| "proc"
	| "xd"
	| "agent"
	| "artifact"
	| "history"
	| "local"
	| "cfg"
	| "ssh"
	| "issue"
	| "pr"
	| "mcp"
	| "omp"
	| "memory"
	| "url"
	| "db"
	| "archive"
	| "uri";

export interface ParsedPath {
	/** Original input, verbatim. */
	raw: string;
	kind: PathKind;
	/** Lowercased scheme for URI-shaped input; null for plain paths. */
	scheme: string | null;
	/** Short chip label, e.g. "proc", "PR", "db". Empty for plain files. */
	label: string;
	/** Primary friendly text: device name, job id, `owner/repo#12`, host… */
	head: string;
	/** Dim secondary tokens appended after head (`cancel`, `/etc/hosts`, filters). */
	tail: string[];
	/** One-line human description for tooltips. */
	title: string;
	/** `kind`-specific key/value detail rows for expanded bodies. */
	fields: Array<[string, string]>;
	/** Input with any trailing read-selector chain removed. */
	path: string;
	/** Trailing read selector chain (`50-100`, `raw:2-4`), split off `path`. */
	sel: string | null;
}

/** A read-tool selector chunk: line ranges (`12`, `1-20,30+5`), `raw`, `conflicts`. */
const SEL_CHUNK_SRC = String.raw`(?:raw|conflicts|-?\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)`;
const SEL_CHUNK_RE = new RegExp(`^${SEL_CHUNK_SRC}$`, "i");
const SEL_CHAIN_RE = new RegExp(`^${SEL_CHUNK_SRC}(?::${SEL_CHUNK_SRC})*$`, "i");

/** `scheme://authority/path?search#hash` — authority keeps `user@host:port`. */
const HIER_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
/** Opaque URI form (`urn:example:x`) — guarded against path-like false positives. */
const OPAQUE_RE = /^([a-z][a-z0-9+.-]*):(.+)$/i;

const ARCHIVE_EXTS = String.raw`zip|jar|apk|whl|tar(?:\.(?:gz|bz2|xz|zst))?|tgz|tbz2|txz|tzst|rar|7z|iso|cab|deb|rpm|cpio|ar|lzh|arj|asar`;
const ARCHIVE_MEMBER_RE = new RegExp(String.raw`^(.*?\.(${ARCHIVE_EXTS})):(.+)$`, "i");
const DB_RE = /^([^:]*\.(?:db|sqlite|sqlite3)):(.*)$/i;
const NUM_RE = /^\d+$/;

function isNum(s: string): boolean {
	return NUM_RE.test(s);
}

/** Split off up to two trailing selector chunks (`:50-100`, `:raw:2-4`). */
function stripSelectorChain(p: string): { path: string; sel: string | null } {
	let path = p;
	const chunks: string[] = [];
	for (let i = 0; i < 2; i++) {
		const idx = path.lastIndexOf(":");
		if (idx <= 0 || !SEL_CHUNK_RE.test(path.slice(idx + 1))) break;
		chunks.unshift(path.slice(idx + 1));
		path = path.slice(0, idx);
	}
	return { path, sel: chunks.length > 0 ? chunks.join(":") : null };
}

/**
 * Selector stripping for a bare authority (`issue://123:raw`). A pure digit
 * chunk is kept — it is far more likely an `ssh://host:2222` port than a
 * one-line selector; ranges/`raw`/`conflicts` still split.
 */
function stripAuthoritySelector(auth: string): { auth: string; sel: string | null } {
	let out = auth;
	const chunks: string[] = [];
	for (let i = 0; i < 2; i++) {
		const idx = out.lastIndexOf(":");
		const chunk = idx >= 0 ? out.slice(idx + 1) : "";
		if (idx <= 0 || /^\d+$/.test(chunk) || !SEL_CHUNK_RE.test(chunk)) break;
		chunks.unshift(chunk);
		out = out.slice(0, idx);
	}
	return { auth: out, sel: chunks.length > 0 ? chunks.join(":") : null };
}

function parsed(partial: Omit<ParsedPath, "fields"> & { fields?: Array<[string, string]> }): ParsedPath {
	return { fields: [], ...partial };
}

/** Query params the issue/pr listing forwards to `gh`. */
const GH_LIST_PARAMS = ["state", "limit", "author", "label", "comments"] as const;

function ghFilters(search: string): { tail: string[]; fields: Array<[string, string]> } {
	const tail: string[] = [];
	const fields: Array<[string, string]> = [];
	if (search.startsWith("?")) {
		const params = new URLSearchParams(search.slice(1));
		for (const key of GH_LIST_PARAMS) {
			const v = params.get(key);
			if (v !== null) {
				tail.push(`${key}=${v}`);
				fields.push([key, v]);
			}
		}
	}
	return { tail, fields };
}

/** `issue://`/`pr://` — number, optional `owner/repo`, optional GHE host, diff family. */
function parseGitItem(scheme: string, auth: string, p: string, search: string, raw: string): ParsedPath {
	const isPr = scheme === "pr";
	const label = isPr ? "PR" : "issue";
	const noun = isPr ? "pull request" : "issue";
	const segs = p.split("/").filter(Boolean);
	const { tail: filters, fields: filterFields } = ghFilters(search);

	let ghe: string | null = null;
	let host = auth;
	let rest = segs;
	// `<ghe-host>/owner/repo/<n>` — dotted/bracketed host, or a no-dot host only
	// when a fully qualified numbered form follows (mirrors the SDK grammar).
	if (host && !isNum(host) && rest.length >= 2 && (/[.:[\]]/.test(host) || (rest.length >= 3 && isNum(rest[2])))) {
		ghe = host;
		host = rest[0];
		rest = rest.slice(1);
	}

	let head: string;
	let title: string;
	const fields: Array<[string, string]> = [];
	const tail: string[] = [];
	if (ghe !== null) {
		tail.push(ghe);
		fields.push(["host", ghe]);
	}
	if (isNum(host)) {
		const number = host;
		const diffSegs = rest;
		head = `#${number}`;
		title = `${noun} #${number}`;
		fields.push(["item", `#${number}`]);
		if (diffSegs.length > 0) {
			const mode = diffSegs[1] === "all" ? "full diff" : isNum(diffSegs[1] ?? "") ? `file ${diffSegs[1]}` : "changed files";
			tail.push(`diff · ${mode}`);
			fields.push(["view", mode]);
			title += ` — ${mode}`;
		}
	} else if (host && rest.length >= 2 && isNum(rest[1])) {
		const repo = `${host}/${rest[0]}`;
		const number = rest[1];
		const diffSegs = rest.slice(2);
		head = `${repo}#${number}`;
		title = `${noun} ${repo}#${number}`;
		fields.push(["repo", repo], ["item", `#${number}`]);
		if (diffSegs.length > 0) {
			const mode = diffSegs[1] === "all" ? "full diff" : isNum(diffSegs[1] ?? "") ? `file ${diffSegs[1]}` : "changed files";
			tail.push(`diff · ${mode}`);
			fields.push(["view", mode]);
			title += ` — ${mode}`;
		}
	} else if (host && rest.length >= 1) {
		head = `${host}/${rest[0]}`;
		title = `recent ${noun}s in ${head}`;
		fields.push(["repo", head], ["view", "list"]);
	} else if (host) {
		head = host;
		title = `recent ${noun}s in ${host}`;
		fields.push(["repo", host], ["view", "list"]);
	} else {
		head = "recent";
		title = `recent ${noun}s (default repo)`;
		fields.push(["view", "list"]);
	}
	return parsed({
		raw,
		kind: scheme as PathKind,
		scheme,
		label,
		head,
		tail: [...tail, ...filters],
		title,
		fields: [...fields, ...filterFields],
		path: raw,
		sel: null,
	});
}

/**
 * Split an `mcp__` device remainder into server/tool for display. Standard
 * `server__tool` wins; flattened `server_tool` names (no `__`) split at the
 * first `_` — a heuristic, so the raw URI stays available in `title`.
 */
function splitMcpName(rest: string): { server: string; tool: string } | null {
	const dsep = rest.indexOf("__");
	if (dsep > 0 && dsep + 2 < rest.length) return { server: rest.slice(0, dsep), tool: rest.slice(dsep + 2) };
	const usep = rest.indexOf("_");
	if (usep > 0 && usep + 1 < rest.length) return { server: rest.slice(0, usep), tool: rest.slice(usep + 1) };
	return null;
}

function parseHierarchical(scheme: string, auth: string, p: string, search: string, hash: string, raw: string): ParsedPath {
	const pathSegs = p.split("/").filter(Boolean);
	switch (scheme) {
		case "proc": {
			if (!auth) {
				return parsed({
					raw,
					kind: "proc",
					scheme,
					label: "proc",
					head: "jobs & services",
					tail: [],
					title: "list background jobs & services",
					fields: [["scope", "all jobs & services"]],
					path: raw,
					sel: null,
				});
			}
			const action = p === "/kill" ? "cancel" : p === "/mode" ? "mode" : "status";
			const title =
				action === "cancel"
					? `cancel job/service '${auth}'`
					: action === "mode"
						? `service mode of '${auth}'`
						: `job/service '${auth}'`;
			return parsed({
				raw,
				kind: "proc",
				scheme,
				label: "proc",
				head: auth,
				tail: action === "status" ? [] : [action],
				title,
				fields: [["target", auth], ["action", action]],
				path: raw,
				sel: null,
			});
		}
		case "xd": {
			const device = `${auth}${p}`.replace(/^\//, "");
			const rest = /^mcp__(.+)$/.exec(device)?.[1];
			if (rest !== undefined) {
				const name = splitMcpName(rest);
				return parsed({
					raw,
					kind: "xd",
					scheme,
					label: "MCP",
					head: name ? `${name.server}::${name.tool}()` : `${rest}()`,
					tail: [],
					title: `MCP tool device '${device}' — ${raw}`,
					fields: name ? [["server", name.server], ["tool", name.tool]] : [["device", device]],
					path: raw,
					sel: null,
				});
			}
			return parsed({
				raw,
				kind: "xd",
				scheme,
				label: "xd",
				head: device || "index",
				tail: [],
				title: `tool device '${device}' — built-in tools, docs & devices`,
				fields: [["device", device]],
				path: raw,
				sel: null,
			});
		}
		case "agent": {
			const broadcast = auth === "all";
			return parsed({
				raw,
				kind: "agent",
				scheme,
				label: "agent",
				head: auth || "…",
				tail: broadcast ? ["broadcast"] : [],
				title: broadcast ? "broadcast to all peer agents" : `peer agent '${auth}' — output or message`,
				fields: broadcast ? [["scope", "all peers"]] : [["to", auth]],
				path: raw,
				sel: null,
			});
		}
		case "artifact":
			return parsed({
				raw,
				kind: "artifact",
				scheme,
				label: "artifact",
				head: `#${auth}`,
				tail: [],
				title: `spilled output artifact #${auth}`,
				fields: [["id", `#${auth}`]],
				path: raw,
				sel: null,
			});
		case "history": {
			const id = `${auth}${p}`.replace(/^\//, "");
			return parsed({
				raw,
				kind: "history",
				scheme,
				label: "history",
				head: id || "current",
				tail: [],
				title: `session transcript '${id}'`,
				fields: [["session", id || "current"]],
				path: raw,
				sel: null,
			});
		}
		case "local": {
			const name = `${auth}${p}`.replace(/^\//, "");
			return parsed({
				raw,
				kind: "local",
				scheme,
				label: "local",
				head: name,
				tail: [],
				title: `shared local file '${name}'`,
				fields: [["file", name]],
				path: raw,
				sel: null,
			});
		}
		case "cfg": {
			const segs = [...auth.split(".").filter(Boolean), ...pathSegs];
			const save = segs[segs.length - 1] === "save";
			const settingSegs = save ? segs.slice(0, -1) : segs;
			const setting = settingSegs.join(".");
			return parsed({
				raw,
				kind: "cfg",
				scheme,
				label: "cfg",
				head: setting || "all settings",
				tail: save ? ["save"] : [],
				title: save ? `omp setting '${setting}' — write persists to config.yml` : `omp setting '${setting || "(all)"}'`,
				fields: [["setting", setting || "(all)"], ...(save ? [["persist", "config.yml"] as [string, string]] : [])],
				path: raw,
				sel: null,
			});
		}
		case "ssh": {
			if (!auth) {
				return parsed({
					raw,
					kind: "ssh",
					scheme,
					label: "ssh",
					head: "configured hosts",
					tail: [],
					title: "list configured SSH hosts",
					fields: [["scope", "configured hosts"]],
					path: raw,
					sel: null,
				});
			}
			const remotePath = `${p}${hash}`;
			return parsed({
				raw,
				kind: "ssh",
				scheme,
				label: "ssh",
				head: auth,
				tail: remotePath && remotePath !== "/" ? [remotePath] : [],
				title: `remote file on '${auth}': ${remotePath || "/"}`,
				fields: [["host", auth], ["path", remotePath || "/"]],
				path: raw,
				sel: null,
			});
		}
		case "issue":
		case "pr":
			return parseGitItem(scheme, auth, p, search, raw);
		case "mcp": {
			const resource = raw.slice("mcp://".length);
			return parsed({
				raw,
				kind: "mcp",
				scheme,
				label: "mcp",
				head: resource,
				tail: [],
				title: `MCP resource '${resource}'`,
				fields: [["resource", resource]],
				path: raw,
				sel: null,
			});
		}
		case "omp": {
			const doc = `${auth}${p}`.replace(/^\//, "");
			return parsed({
				raw,
				kind: "omp",
				scheme,
				label: "omp",
				head: doc || "index",
				tail: [],
				title: `harness documentation '${doc}'`,
				fields: [["doc", doc || "index"]],
				path: raw,
				sel: null,
			});
		}
		case "memory": {
			const ns = auth || "…";
			const memPath = p.replace(/^\//, "");
			return parsed({
				raw,
				kind: "memory",
				scheme,
				label: "memory",
				head: ns,
				tail: memPath ? [memPath] : [],
				title: `memory '${ns}${memPath ? `/${memPath}` : ""}'`,
				fields: [["namespace", ns], ...(memPath ? [["path", memPath] as [string, string]] : [])],
				path: raw,
				sel: null,
			});
		}
		case "http":
		case "https": {
			const rest = `${p}${search}${hash}`;
			return parsed({
				raw,
				kind: "url",
				scheme,
				label: "web",
				head: auth,
				tail: rest && rest !== "/" ? [rest] : [],
				title: `${scheme}://${auth}${rest}`,
				fields: [["host", auth]],
				path: raw,
				sel: null,
			});
		}
		default: {
			const rest = `${auth}${p}${search}${hash}`;
			return parsed({
				raw,
				kind: "uri",
				scheme,
				label: scheme,
				head: rest,
				tail: [],
				title: raw,
				path: raw,
				sel: null,
			});
		}
	}
}

function parsePlainPath(raw: string): ParsedPath {
	const qIdx = raw.indexOf("?");
	const body = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
	const search = qIdx >= 0 ? raw.slice(qIdx) : "";

	const archive = body.match(ARCHIVE_MEMBER_RE);
	if (archive) {
		return parsed({
			raw,
			kind: "archive",
			scheme: null,
			label: "archive",
			head: shortenPath(archive[1]),
			tail: [archive[3]],
			title: `archive ${archive[1]} → member ${archive[3]}`,
			fields: [["archive", archive[1]], ["member", archive[3]]],
			path: raw,
			sel: null,
		});
	}

	const db = body.match(DB_RE);
	if (db) {
		const sep = db[2].indexOf(":");
		const table = sep >= 0 ? db[2].slice(0, sep) : db[2];
		const key = sep >= 0 ? db[2].slice(sep + 1) : null;
		const queryTail: string[] = [];
		const queryFields: Array<[string, string]> = [];
		if (search.startsWith("?")) {
			const params = new URLSearchParams(search.slice(1));
			for (const [k, v] of params) {
				queryTail.push(`${k}=${v}`);
				queryFields.push([k, v]);
			}
		}
		return parsed({
			raw,
			kind: "db",
			scheme: null,
			label: "db",
			head: shortenPath(db[1]),
			tail: [table, ...(key ? [`row ${key}`] : []), ...queryTail],
			title: `SQLite ${db[1]} · table ${table}${key ? ` · row ${key}` : ""}`,
			fields: [
				["database", db[1]],
				...(table ? [["table", table] as [string, string]] : []),
				...(key ? [["key", key] as [string, string]] : []),
				...queryFields,
			],
			path: raw,
			sel: null,
		});
	}

	const seg = stripSelectorChain(raw);
	return parsed({
		raw,
		kind: "file",
		scheme: null,
		label: "",
		head: seg.path,
		tail: [],
		title: "",
		path: seg.path,
		sel: seg.sel,
	});
}

/**
 * Parse a tool `path` argument into a friendly description. Non-string and
 * empty inputs degrade to a `file` parse with `head: ""`.
 */
export function parseToolPath(raw: string): ParsedPath {
	if (typeof raw !== "string" || raw === "") {
		return parsed({ raw: "", kind: "file", scheme: null, label: "", head: "", tail: [], title: "", path: raw ?? "", sel: null });
	}
	const hier = raw.match(HIER_RE);
	if (hier) {
		const scheme = hier[1].toLowerCase();
		let auth = hier[2] ?? "";
		let p = hier[3] ?? "";
		let sel: string | null = null;
		if (p) {
			const seg = stripSelectorChain(p);
			p = seg.path;
			sel = seg.sel;
		} else {
			const seg = stripAuthoritySelector(auth);
			auth = seg.auth;
			sel = seg.sel;
		}
		const out = parseHierarchical(scheme, auth, p, hier[4] ?? "", hier[5] ?? "", raw);
		return sel ? { ...out, sel } : out;
	}
	const opaque = raw.match(OPAQUE_RE);
	if (opaque && opaque[1].length > 1 && !opaque[1].includes(".") && !SEL_CHAIN_RE.test(opaque[2])) {
		return parsed({
			raw,
			kind: "uri",
			scheme: opaque[1].toLowerCase(),
			label: opaque[1].toLowerCase(),
			head: opaque[2],
			tail: [],
			title: raw,
			path: raw,
			sel: null,
		});
	}
	return parsePlainPath(raw);
}

/** `proc://` operation of a parsed path, or null for other kinds. */
export function procAction(p: ParsedPath): "list" | "status" | "stdin" | "mode" | "cancel" | null {
	if (p.kind !== "proc") return null;
	if (!p.raw.slice("proc://".length).split("/")[0]) return "list";
	if (p.tail.includes("cancel")) return "cancel";
	if (p.tail.includes("mode")) return "mode";
	return "stdin";
}
