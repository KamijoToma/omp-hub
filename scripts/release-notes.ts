/**
 * Deterministic release notes for a pushed version tag.
 *
 * Usage: bun scripts/release-notes.ts <vX.Y.Z> [output-path=release-notes.md]
 *
 * Baseline: the newest published GitHub release whose tag is semver-older than the target and
 * reachable from the target commit. Releases, not tags, are consulted, so a tag without a
 * release ("silent tag") never truncates the range, and a rerun whose target release already
 * exists skips the target itself. Without a published predecessor the notes cover the entire
 * history reachable from the target, root commit included.
 *
 * Commits: merges and maintenance types (chore/ci/test/build/style) are skipped; breaking
 * changes always surface, even from a maintenance type. Entries keep their scope when present
 * and escape Markdown control characters. gh/git failures abort the run instead of writing
 * partial notes.
 */
/** Sections in render order; empty sections are omitted. */
export const CATEGORY_ORDER = ["Breaking Changes", "Features", "Fixes", "Changes", "Documentation"] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

export const DEFAULT_OUTPUT_PATH = "release-notes.md";
export const USAGE = "usage: bun scripts/release-notes.ts <vX.Y.Z> [output-path]";

const MAINTENANCE_NOTE = "_No user-visible changes (maintenance only)._";

/** Prefixes understood as Conventional Commits; anything else is treated as a bare scope. */
const CONVENTIONAL_TYPES: Record<string, true> = {
	feat: true,
	fix: true,
	perf: true,
	refactor: true,
	docs: true,
	chore: true,
	ci: true,
	test: true,
	build: true,
	style: true,
	revert: true,
};

/** Types that never reach the notes, unless the commit is marked breaking. */
const MAINTENANCE_TYPES: Record<string, true> = {
	chore: true,
	ci: true,
	test: true,
	build: true,
	style: true,
};

/** `word`, `word(scope)`, `word(scope)!` or `word!` followed by `: description`. */
const PREFIX_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)(?:\(([^()]*)\))?(!)?:\s*(.+)$/;
/** Conventional Commits breaking-change footer (`BREAKING CHANGE:` or `BREAKING-CHANGE:`). */
const BREAKING_FOOTER_PATTERN = /^\s*BREAKING[ -]CHANGE\b/m;
/** Merge commits and "merge main" sync commits are not user-visible changes. */
const MERGE_SUBJECT_PATTERN = /^merge\b/i;
/** Markdown constructs that would otherwise restructure a list item. */
const MARKDOWN_SPECIALS = /[\\`*_{}\[\]<>|~#]/g;

/** `git log` record format: sha, parents, subject, body — US/RS separated. */
const LOG_FORMAT = "--format=%H%x1f%P%x1f%s%x1f%b%x1e";
/** `gh release list` page size leaf; a full page means the listing may be truncated. */
const RELEASE_LIST_LIMIT = 1000;

export class ReleaseNotesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReleaseNotesError";
	}
}

export interface ExecResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ExecOptions {
	readonly env?: Record<string, string | undefined>;
}

/** Runs a command and captures its exit status and output; throws nothing itself. */
export type Exec = (command: readonly string[], options?: ExecOptions) => ExecResult;

export const spawnExec: Exec = (command, options) => {
	const result = Bun.spawnSync({
		cmd: [...command],
		env: { ...process.env, ...options?.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		status: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
};

export interface CommitRecord {
	readonly sha: string;
	readonly parents: readonly string[];
	readonly subject: string;
	readonly body: string;
}

export interface ParsedCommit {
	readonly type: string | null;
	readonly scope: string | null;
	readonly breaking: boolean;
	readonly description: string;
}

export interface Semver {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly (string | number)[];
}

export interface PublishedRelease {
	readonly tagName: string;
	readonly publishedAt: string | null;
	readonly isDraft: boolean;
	readonly isPrerelease: boolean;
}

export interface ReleaseNotesInput {
	readonly target: string;
	readonly baseline: string | null;
	readonly repoUrl: string;
	readonly commits: readonly CommitRecord[];
}

export interface GenerateOptions {
	readonly tag: string;
	readonly exec?: Exec;
	readonly env?: Record<string, string | undefined>;
}

export interface GeneratedNotes {
	readonly target: string;
	readonly baseline: string | null;
	readonly repoUrl: string;
	readonly commits: readonly CommitRecord[];
	readonly markdown: string;
}

export interface CliDependencies {
	readonly exec?: Exec;
	readonly env?: Record<string, string | undefined>;
	readonly write?: (path: string, content: string) => Promise<void>;
}

/** Splits a Conventional Commits subject into type, scope, breaking flag, and description. */
export function parseCommit(subject: string, body = ""): ParsedCommit {
	const prefix = PREFIX_PATTERN.exec(subject);
	const breaking = BREAKING_FOOTER_PATTERN.test(body) || (prefix !== null && prefix[3] === "!");
	if (prefix === null) {
		return { type: null, scope: null, breaking, description: subject.trim() };
	}
	const prefixWord = prefix[1];
	const scope = prefix[2];
	const type = prefixWord.toLowerCase();
	const description = prefix[4].trim();
	// `web: …` and `hub: …` are scopes, not types: only known types get type semantics,
	// while the parenthesized form (`web(api): …`) stays a type because it is unambiguous.
	if (scope === undefined && CONVENTIONAL_TYPES[type] !== true) {
		return { type: null, scope: prefixWord, breaking, description };
	}
	return { type, scope: scope === undefined || scope.trim() === "" ? null : scope.trim(), breaking, description };
}

/** A merge commit: more than one parent, or a git merge subject (`Merge branch 'x'`, `merge main`). */
export function isMergeCommit(commit: CommitRecord): boolean {
	return commit.parents.length > 1 || MERGE_SUBJECT_PATTERN.test(commit.subject.trim());
}

/** Section for a commit, or null when it is a merge or maintenance-only work. */
export function categorizeCommit(commit: CommitRecord): Category | null {
	if (isMergeCommit(commit)) return null;
	const parsed = parseCommit(commit.subject, commit.body);
	// Breaking changes are user-visible by definition, so they trump both the category
	// mapping and the maintenance exclusion (`chore!: drop node 18` must not vanish).
	if (parsed.breaking) return "Breaking Changes";
	if (parsed.type === "feat") return "Features";
	if (parsed.type === "fix") return "Fixes";
	if (parsed.type === "docs") return "Documentation";
	if (parsed.type === "perf" || parsed.type === "refactor") return "Changes";
	if (parsed.type !== null && MAINTENANCE_TYPES[parsed.type] === true) return null;
	return "Changes";
}

/** Escapes Markdown constructs and collapses whitespace so a subject cannot restructure the list. */
export function escapeMarkdown(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(MARKDOWN_SPECIALS, (character) => `\\${character}`)
		.replace(/^([-+])(?=\s)/, "\\$1")
		.replace(/^(\d+)\.(?=\s)/, "$1\\.");
}

/** One `- **scope:** subject ([sha](link))` list item for a non-merge commit. */
export function formatCommitLine(commit: CommitRecord, repoUrl: string): string {
	const parsed = parseCommit(commit.subject, commit.body);
	const scope = parsed.scope === null ? "" : `**${escapeMarkdown(parsed.scope)}:** `;
	const shortSha = commit.sha.slice(0, 7);
	return `- ${scope}${escapeMarkdown(parsed.description)} ([${shortSha}](${repoUrl}/commit/${commit.sha}))`;
}

/** Parses `git log` output produced with {@link LOG_FORMAT}. */
export function parseLog(output: string): CommitRecord[] {
	const commits: CommitRecord[] = [];
	for (const chunk of output.split("\x1e")) {
		const record = chunk.replace(/^[\r\n]+/, "");
		if (record.trim() === "") continue;
		const [sha, parents = "", subject = "", body = ""] = record.split("\x1f");
		if (sha === undefined || sha.trim() === "" || subject === "") continue;
		commits.push({
			sha: sha.trim(),
			parents: parents.split(/\s+/).filter((parent) => parent !== ""),
			subject,
			body,
		});
	}
	return commits;
}

/** Parses `vX.Y.Z` / `X.Y.Z` (optionally `-prerelease`, `+build`) into a comparable semver. */
export function parseSemver(tag: string): Semver | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag.trim());
	if (match === null) return null;
	const prerelease = match[4] === undefined ? [] : match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

/** Standard semver precedence: negative, zero, or positive when `a` is older, equal, or newer. */
export function compareSemver(a: Semver, b: Semver): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.prerelease.length !== b.prerelease.length) {
		if (a.prerelease.length === 0) return 1;
		if (b.prerelease.length === 0) return -1;
	}
	const length = Math.max(a.prerelease.length, b.prerelease.length);
	for (let index = 0; index < length; index++) {
		const left = a.prerelease[index];
		const right = b.prerelease[index];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;
		const leftNumeric = typeof left === "number";
		const rightNumeric = typeof right === "number";
		if (leftNumeric && rightNumeric) return left < right ? -1 : 1;
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return String(left) < String(right) ? -1 : 1;
	}
	return 0;
}

/**
 * Newest published release strictly older than the target and reachable from it, or null when
 * there is no published predecessor. Drafts, non-version tags, and the target's own release
 * (rerun) are never baselines; unreachable releases are skipped so the range stays an ancestry.
 */
export function selectBaseline(
	targetTag: string,
	releases: readonly PublishedRelease[],
	isReachable: (tag: string) => boolean,
): string | null {
	const target = parseSemver(targetTag);
	if (target === null) {
		throw new ReleaseNotesError(`target tag ${JSON.stringify(targetTag)} is not a vX.Y.Z version tag`);
	}
	let best: PublishedRelease | null = null;
	let bestVersion: Semver | null = null;
	for (const release of releases) {
		if (release.isDraft) continue;
		if (release.tagName === targetTag) continue;
		const version = parseSemver(release.tagName);
		if (version === null || compareSemver(version, target) >= 0) continue;
		if (!isReachable(release.tagName)) continue;
		if (best === null || bestVersion === null || compareBaseline(version, release, bestVersion, best) > 0) {
			best = release;
			bestVersion = version;
		}
	}
	return best === null ? null : best.tagName;
}

/** Orders candidates: higher version, then newer publication, then a stable tag-name tie-break. */
function compareBaseline(
	version: Semver,
	release: PublishedRelease,
	bestVersion: Semver,
	best: PublishedRelease,
): number {
	const byVersion = compareSemver(version, bestVersion);
	if (byVersion !== 0) return byVersion;
	const byPublished = (release.publishedAt ?? "").localeCompare(best.publishedAt ?? "");
	if (byPublished !== 0) return byPublished;
	if (release.tagName !== best.tagName) return release.tagName < best.tagName ? 1 : -1;
	return 0;
}

/** Full release-notes document: ordered sections (empty ones omitted) plus the changelog link. */
export function renderReleaseNotes(input: ReleaseNotesInput): string {
	const sections: Record<Category, string[]> = {
		"Breaking Changes": [],
		Features: [],
		Fixes: [],
		Changes: [],
		Documentation: [],
	};
	for (const commit of input.commits) {
		const category = categorizeCommit(commit);
		if (category === null) continue;
		sections[category].push(formatCommitLine(commit, input.repoUrl));
	}
	const blocks: string[] = [];
	for (const category of CATEGORY_ORDER) {
		const entries = sections[category];
		if (entries.length === 0) continue;
		blocks.push(`## ${category}\n\n${entries.join("\n")}`);
	}
	const body = blocks.length === 0 ? MAINTENANCE_NOTE : blocks.join("\n\n");
	const reference = input.baseline === null ? input.target : `${input.baseline}...${input.target}`;
	const url =
		input.baseline === null
			? `${input.repoUrl}/commits/${encodeURIComponent(input.target)}`
			: `${input.repoUrl}/compare/${encodeURIComponent(input.baseline)}...${encodeURIComponent(input.target)}`;
	return `${body}\n\n**Full Changelog**: [${reference}](${url})\n`;
}

/** `owner/repo` for an env-style slug, an `origin` URL (https/ssh/scp), or null. */
export function repositoryFromRemote(remote: string): string | null {
	const value = remote.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
	if (value === "") return null;
	let path: string | null = null;
	const scp = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/\/)(.+)$/.exec(value);
	if (scp !== null) {
		path = scp[1];
	} else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
		try {
			path = new URL(value).pathname;
		} catch {
			return null;
		}
	} else if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
		path = value;
	}
	if (path === null) return null;
	const segments = path
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment !== "");
	if (segments.length < 2) return null;
	const slug = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
	return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}

function commandError(command: string, result: ExecResult): ReleaseNotesError {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
	return new ReleaseNotesError(`${command} failed: ${detail}`);
}

function resolveRepositorySlug(exec: Exec, env: Record<string, string | undefined>): string {
	const fromEnv = repositoryFromRemote(env.GITHUB_REPOSITORY ?? "");
	if (fromEnv !== null) return fromEnv;
	const remote = exec(["git", "config", "--get", "remote.origin.url"]);
	if (remote.status === 0) {
		const fromRemote = repositoryFromRemote(remote.stdout);
		if (fromRemote !== null) return fromRemote;
	}
	throw new ReleaseNotesError("cannot determine the repository: set GITHUB_REPOSITORY or an origin remote");
}

/** Resolves a tag to its commit, null when the tag is not in the local clone. */
function resolveTag(exec: Exec, tag: string): string | null {
	const result = exec(["git", "rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
	if (result.status === 0) {
		const sha = result.stdout.trim();
		return sha === "" ? null : sha;
	}
	if (result.status > 1) throw commandError(`git rev-parse ${tag}^{commit}`, result);
	return null;
}

function isAncestor(exec: Exec, ancestor: string, descendant: string): boolean {
	const result = exec(["git", "merge-base", "--is-ancestor", ancestor, descendant]);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw commandError(`git merge-base --is-ancestor ${ancestor} ${descendant}`, result);
}

/** Published releases from `gh`, newest first; a full page is an error, not silent truncation. */
function loadReleases(exec: Exec, repoSlug: string): PublishedRelease[] {
	const result = exec([
		"gh",
		"release",
		"list",
		"--limit",
		String(RELEASE_LIST_LIMIT),
		"--exclude-drafts",
		"--json",
		"tagName,publishedAt,isDraft,isPrerelease",
	]);
	if (result.status !== 0) throw commandError(`gh release list (${repoSlug})`, result);
	let payload: unknown;
	try {
		payload = JSON.parse(result.stdout);
	} catch {
		throw new ReleaseNotesError(`gh release list (${repoSlug}) returned invalid JSON`);
	}
	if (!Array.isArray(payload)) {
		throw new ReleaseNotesError(`gh release list (${repoSlug}) returned ${typeof payload} instead of a list`);
	}
	if (payload.length >= RELEASE_LIST_LIMIT) {
		throw new ReleaseNotesError(
			`gh release list (${repoSlug}) returned ${RELEASE_LIST_LIMIT} releases; raise RELEASE_LIST_LIMIT to pick the right baseline`,
		);
	}
	const releases: PublishedRelease[] = [];
	for (const entry of payload) {
		if (typeof entry !== "object" || entry === null) continue;
		const release = entry as Record<string, unknown>;
		if (typeof release.tagName !== "string" || release.tagName === "") continue;
		releases.push({
			tagName: release.tagName,
			publishedAt: typeof release.publishedAt === "string" ? release.publishedAt : null,
			isDraft: release.isDraft === true,
			isPrerelease: release.isPrerelease === true,
		});
	}
	return releases;
}

/**
 * Collects the commit range and renders the notes: `gh release list` picks the baseline,
 * `git log` walks `<baseline>..<target>` (or the whole target history without a baseline).
 */
export function generateTagReleaseNotes(options: GenerateOptions): GeneratedNotes {
	const exec = options.exec ?? spawnExec;
	const env = options.env ?? process.env;
	const tag = options.tag.trim();
	if (tag === "") throw new ReleaseNotesError("missing tag argument");
	const repository = resolveRepositorySlug(exec, env);
	const origin = env.GITHUB_SERVER_URL ?? "";
	const repoUrl = `${(origin === "" ? "https://github.com" : origin).replace(/\/+$/, "")}/${repository}`;
	const targetSha = resolveTag(exec, tag);
	if (targetSha === null) {
		throw new ReleaseNotesError(`tag ${JSON.stringify(tag)} is not in this clone (fetch tags, e.g. fetch-depth: 0)`);
	}
	const releases = loadReleases(exec, repository);
	const resolved = new Map<string, string | null>();
	const baseline = selectBaseline(tag, releases, (candidate) => {
		if (!resolved.has(candidate)) resolved.set(candidate, resolveTag(exec, candidate));
		const sha = resolved.get(candidate) ?? null;
		return sha !== null && isAncestor(exec, sha, targetSha);
	});
	const range = baseline === null ? targetSha : `${resolved.get(baseline) ?? baseline}..${targetSha}`;
	const log = exec(["git", "log", "--no-merges", LOG_FORMAT, range]);
	if (log.status !== 0) throw commandError(`git log ${range}`, log);
	const commits = parseLog(log.stdout);
	return {
		target: tag,
		baseline,
		repoUrl,
		commits,
		markdown: renderReleaseNotes({ target: tag, baseline, repoUrl, commits }),
	};
}

/**
 * CLI entry point: `<tag> [output-path]`, writes {@link DEFAULT_OUTPUT_PATH} by default, and
 * rejects on usage, `gh`, or git errors so a release is never published with partial notes.
 */
export async function main(
	argv: readonly string[],
	dependencies: CliDependencies = {},
): Promise<GeneratedNotes & { readonly outputPath: string }> {
	const [tag, outputPath, ...extra] = argv;
	if (tag === undefined || extra.length > 0) throw new ReleaseNotesError(USAGE);
	const notes = generateTagReleaseNotes({ tag, exec: dependencies.exec, env: dependencies.env });
	const path = outputPath === undefined || outputPath === "" ? DEFAULT_OUTPUT_PATH : outputPath;
	const write = dependencies.write ?? ((target: string, content: string) => Bun.write(target, content).then(() => {}));
	await write(path, notes.markdown);
	return { ...notes, outputPath: path };
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.then(({ outputPath, target, baseline, commits }) => {
			const scope = baseline === null ? `history through ${target}` : `${baseline}...${target}`;
			console.log(`release-notes: wrote ${outputPath} (${commits.length} commits, ${scope})`);
		})
		.catch((error: unknown) => {
			console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		});
}
