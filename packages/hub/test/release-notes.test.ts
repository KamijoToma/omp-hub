/**
 * release-notes generator (scripts/release-notes.ts) with a scripted git/gh world:
 * category precedence, escaping, baseline selection (silent tags, reruns, non-ancestors,
 * drafts), root-inclusive first releases, merge exclusion, and gh/git failure handling.
 */
import { describe, expect, test } from "bun:test";
import {
	CATEGORY_ORDER,
	DEFAULT_OUTPUT_PATH,
	categorizeCommit,
	compareSemver,
	escapeMarkdown,
	formatCommitLine,
	generateTagReleaseNotes,
	isMergeCommit,
	main,
	parseCommit,
	parseLog,
	parseSemver,
	renderReleaseNotes,
	repositoryFromRemote,
	selectBaseline,
	type Category,
	type CommitRecord,
	type Exec,
	type ExecResult,
	type PublishedRelease,
	type Semver,
} from "../../../scripts/release-notes.ts";

const sha = (prefix: string): string => prefix.repeat(40).slice(0, 40);
const ROOT_SHA = sha("a1b2c3d4");
const FEAT_SHA = sha("b2c3d4e5");
const DOC_SHA = sha("c3d4e5f6");

const record = (options: { sha: string; subject: string; parents?: readonly string[]; body?: string }): CommitRecord => ({
	sha: options.sha,
	subject: options.subject,
	parents: options.parents ?? [],
	body: options.body ?? "",
});

const release = (tagName: string, overrides: Partial<PublishedRelease> = {}): PublishedRelease => ({
	tagName,
	publishedAt: "2026-01-01T00:00:00Z",
	isDraft: false,
	isPrerelease: false,
	...overrides,
});

const version = (tag: string): Semver => {
	const parsed = parseSemver(tag);
	if (parsed === null) throw new Error(`test fixture is not a version: ${tag}`);
	return parsed;
};

/** Deterministic 40-hex commit id per tag, so a fake clone can resolve revs. */
const shaForTag = (tag: string): string => {
	let hash = 0x811c9dc5;
	for (const character of tag) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
	return hash.toString(16).padStart(8, "0").repeat(5);
};

/** `git log` output for the given commits, in the script's US/RS record format. */
const gitLog = (...commits: readonly CommitRecord[]): string =>
	commits.map((commit) => `${commit.sha}\x1f${commit.parents.join(" ")}\x1f${commit.subject}\x1f${commit.body}\x1e\n`).join("");

interface World {
	readonly releases?: readonly PublishedRelease[];
	readonly ghError?: string;
	readonly commits?: readonly CommitRecord[];
	readonly logError?: string;
	readonly unreachableTags?: readonly string[];
	readonly missingTags?: readonly string[];
	readonly fatalTags?: readonly string[];
	readonly mergeBaseError?: string;
}

/** Scripted `git`/`gh` double that records every invocation the script makes. */
const world = (options: World = {}): { exec: Exec; calls: string[][] } => {
	const calls: string[][] = [];
	const unreachable = (options.unreachableTags ?? []).map((tag) => shaForTag(tag));
	const missing = options.missingTags ?? [];
	const exec: Exec = (command): ExecResult => {
		calls.push([...command]);
		const [tool, ...args] = command;
		if (tool === "gh") {
			if (options.ghError !== undefined) return { status: 1, stdout: "", stderr: options.ghError };
			return { status: 0, stdout: JSON.stringify(options.releases ?? []), stderr: "" };
		}
		if (tool === "git" && args[0] === "rev-parse") {
			const tag = args[args.length - 1].replace(/\^\{commit\}$/, "");
			if (missing.includes(tag)) return { status: 1, stdout: "", stderr: "" };
			if ((options.fatalTags ?? []).includes(tag)) return { status: 128, stdout: "", stderr: `fatal: bad object ${tag}` };
			return { status: 0, stdout: `${shaForTag(tag)}\n`, stderr: "" };
		}
		if (tool === "git" && args[0] === "merge-base") {
			if (options.mergeBaseError !== undefined) return { status: 128, stdout: "", stderr: options.mergeBaseError };
			return { status: unreachable.includes(args[2]) ? 1 : 0, stdout: "", stderr: "" };
		}
		if (tool === "git" && args[0] === "log") {
			if (options.logError !== undefined) return { status: 1, stdout: "", stderr: options.logError };
			return { status: 0, stdout: gitLog(...(options.commits ?? [])), stderr: "" };
		}
		if (tool === "git") return { status: 0, stdout: "https://github.com/acme/widget.git\n", stderr: "" };
		return { status: 1, stdout: "", stderr: `unexpected command: ${command.join(" ")}` };
	};
	return { exec, calls };
};

/** Write spy for `main`, so tests assert both the path and the content. */
const writer = (): { write: (path: string, content: string) => Promise<void>; writes: Array<{ path: string; content: string }> } => {
	const writes: Array<{ path: string; content: string }> = [];
	return {
		writes,
		write: async (path, content) => {
			writes.push({ path, content });
		},
	};
};

describe("commit classification", () => {
	const cases: ReadonlyArray<readonly [subject: string, category: Category | null]> = [
		["feat(web): tools whitelist multi-select picker", "Features"],
		["fix(hub): snapshot resume ids at request time", "Fixes"],
		["perf(relay): drop idle frames", "Changes"],
		["refactor: split supervisor children", "Changes"],
		["docs(e2e): record stats bar verification", "Documentation"],
		["chore(deps): bump typescript", null],
		["ci: add workflow", null],
		["test(web): cover rename routing", null],
		["build: drop tarball", null],
		["style: reflow tabs", null],
	];
	for (const [subject, category] of cases) {
		test(`classifies ${subject}`, () => {
			expect(categorizeCommit(record({ sha: FEAT_SHA, subject }))).toBe(category);
		});
	}

	test("keeps the scope and strips the prefix from the entry text", () => {
		const parsed = parseCommit("feat(web): tools whitelist multi-select picker");
		expect(parsed).toEqual({
			type: "feat",
			scope: "web",
			breaking: false,
			description: "tools whitelist multi-select picker",
		});
		expect(formatCommitLine(record({ sha: FEAT_SHA, subject: "feat(web): tools whitelist" }), "https://github.com/acme/widget")).toBe(
			`- **web:** tools whitelist ([${FEAT_SHA.slice(0, 7)}](https://github.com/acme/widget/commit/${FEAT_SHA}))`,
		);
	});

	test("breaking markers trump the category they would otherwise land in", () => {
		const bang = record({ sha: FEAT_SHA, subject: "feat(api)!: drop v1 routes" });
		const footer = record({
			sha: FEAT_SHA,
			subject: "fix: rotate tokens",
			body: "Details.\n\nBREAKING CHANGE: token format changed",
		});
		const dashed = record({ sha: FEAT_SHA, subject: "docs: rewrite guide", body: "BREAKING-CHANGE: guide moved" });
		expect(categorizeCommit(bang)).toBe("Breaking Changes");
		expect(categorizeCommit(footer)).toBe("Breaking Changes");
		expect(categorizeCommit(dashed)).toBe("Breaking Changes");
		expect(parseCommit(bang.subject).description).toBe("drop v1 routes");
	});

	test("surfaces a breaking maintenance commit instead of dropping it", () => {
		expect(categorizeCommit(record({ sha: FEAT_SHA, subject: "chore!: drop node 18" }))).toBe("Breaking Changes");
	});

	test("treats an unknown prefix as a scope, not a type", () => {
		const web = parseCommit("web: render compaction method in the transcript divider");
		expect(web.type).toBeNull();
		expect(web.scope).toBe("web");
		expect(categorizeCommit(record({ sha: FEAT_SHA, subject: "hub: cap history list height" }))).toBe("Changes");
		expect(categorizeCommit(record({ sha: FEAT_SHA, subject: "web: collapsible todo panel" }))).toBe("Changes");
	});

	test("keeps untyped subjects as user-visible changes", () => {
		const subject = "Resume historical omp sessions from the hub";
		const parsed = parseCommit(subject);
		expect(parsed.scope).toBeNull();
		expect(parsed.description).toBe(subject);
		expect(categorizeCommit(record({ sha: FEAT_SHA, subject }))).toBe("Changes");
	});

	test("excludes merges by parent count and by subject", () => {
		const merged = record({ sha: FEAT_SHA, parents: [DOC_SHA, ROOT_SHA], subject: "Merge branch 'feat/daemon-restart'" });
		const squashed = record({ sha: FEAT_SHA, subject: "Merge pull request #12 from acme/feat" });
		const sync = record({ sha: FEAT_SHA, subject: "merge main: adapt MCP management" });
		expect(isMergeCommit(merged)).toBe(true);
		expect(isMergeCommit(squashed)).toBe(true);
		expect(categorizeCommit(merged)).toBeNull();
		expect(categorizeCommit(squashed)).toBeNull();
		expect(categorizeCommit(sync)).toBeNull();
		expect(categorizeCommit(record({ sha: FEAT_SHA, subject: "Mergeable state machine refactor" }))).toBe("Changes");
	});

	test("keeps revert commits visible as changes", () => {
		expect(categorizeCommit(record({ sha: FEAT_SHA, subject: 'revert: "feat: drop v1 routes"' }))).toBe("Changes");
	});
});

describe("markdown escaping", () => {
	test("escapes emphasis, code, link, table, and heading characters", () => {
		expect(escapeMarkdown("use * and _ and `code`")).toBe("use \\* and \\_ and \\`code\\`");
		expect(escapeMarkdown("see [docs](x) | <tag> #12")).toBe("see \\[docs\\](x) \\| \\<tag\\> \\#12");
	});

	test("collapses whitespace so a subject stays one list item", () => {
		expect(escapeMarkdown("  fix\ttwo\nlines  ")).toBe("fix two lines");
	});

	test("neutralizes leading list markers but leaves inner dashes alone", () => {
		expect(escapeMarkdown("- nested bullet")).toBe("\\- nested bullet");
		expect(escapeMarkdown("1. ordered")).toBe("1\\. ordered");
		expect(escapeMarkdown("a - b")).toBe("a - b");
	});
});

describe("release notes rendering", () => {
	const repoUrl = "https://github.com/acme/widget";

	test("orders sections and omits empty ones", () => {
		const markdown = renderReleaseNotes({
			target: "v2.0.0",
			baseline: "v1.0.0",
			repoUrl,
			commits: [
				record({ sha: DOC_SHA, subject: "docs: guide" }),
				record({ sha: FEAT_SHA, subject: "fix: bug" }),
				record({ sha: ROOT_SHA, subject: "chore: nothing user visible" }),
				record({ sha: FEAT_SHA, subject: "feat: thing" }),
				record({ sha: FEAT_SHA, subject: "feat!: breaking thing" }),
			],
		});
		expect(markdown.split("\n").filter((line) => line.startsWith("## "))).toEqual([
			"## Breaking Changes",
			"## Features",
			"## Fixes",
			"## Documentation",
		]);
		expect(markdown).not.toContain("nothing user visible");
		expect(markdown).not.toContain("## Changes");
	});

	test("links the baseline compare range as the full changelog", () => {
		const markdown = renderReleaseNotes({ target: "v2.0.0", baseline: "v1.0.0", repoUrl, commits: [] });
		expect(markdown).toBe(
			"_No user-visible changes (maintenance only)._\n\n" +
				"**Full Changelog**: [v1.0.0...v2.0.0](https://github.com/acme/widget/compare/v1.0.0...v2.0.0)\n",
		);
	});

	test("links the full history when there is no baseline", () => {
		const markdown = renderReleaseNotes({ target: "v2.0.0", baseline: null, repoUrl, commits: [] });
		expect(markdown).toEndWith("**Full Changelog**: [v2.0.0](https://github.com/acme/widget/commits/v2.0.0)\n");
	});

	test("emits a maintenance note when only chores, tests, and merges are in range", () => {
		const markdown = renderReleaseNotes({
			target: "v1.1.0",
			baseline: "v1.0.0",
			repoUrl,
			commits: [
				record({ sha: FEAT_SHA, subject: "chore: ignore .omp/" }),
				record({ sha: FEAT_SHA, subject: "test: cover release notes" }),
				record({ sha: FEAT_SHA, parents: [DOC_SHA, ROOT_SHA], subject: "Merge branch 'wt/x'" }),
			],
		});
		expect(markdown).toBe(
			"_No user-visible changes (maintenance only)._\n\n" +
				"**Full Changelog**: [v1.0.0...v1.1.0](https://github.com/acme/widget/compare/v1.0.0...v1.1.0)\n",
		);
	});

	test("renders every documented section in order when all are present", () => {
		const markdown = renderReleaseNotes({
			target: "v2.0.0",
			baseline: "v1.0.0",
			repoUrl,
			commits: [
				record({ sha: DOC_SHA, subject: "docs: guide" }),
				record({ sha: FEAT_SHA, subject: "refactor: tidy" }),
				record({ sha: ROOT_SHA, subject: "fix: bug" }),
				record({ sha: FEAT_SHA, subject: "feat: thing" }),
				record({ sha: FEAT_SHA, subject: "feat!: breaking thing" }),
			],
		});
		expect(markdown.split("\n").filter((line) => line.startsWith("## "))).toEqual(CATEGORY_ORDER.map((name) => `## ${name}`));
	});
});

describe("git log parsing", () => {
	test("parses shas, parents, subjects, and multi-line bodies", () => {
		const output = gitLog(
			record({ sha: ROOT_SHA, subject: "Add incremental demo deployer" }),
			record({ sha: FEAT_SHA, parents: [ROOT_SHA], subject: "feat(hub): first feature", body: "Line one.\n\nBREAKING CHANGE: wire change" }),
		);
		expect(parseLog(output)).toEqual([
			{ sha: ROOT_SHA, parents: [], subject: "Add incremental demo deployer", body: "" },
			{ sha: FEAT_SHA, parents: [ROOT_SHA], subject: "feat(hub): first feature", body: "Line one.\n\nBREAKING CHANGE: wire change" },
		]);
	});

	test("returns nothing for empty output", () => {
		expect(parseLog("")).toEqual([]);
	});

	test("keeps the root commit of a first release in the notes", () => {
		const commits = parseLog(gitLog(record({ sha: ROOT_SHA, subject: "Add incremental demo deployer" }), record({ sha: FEAT_SHA, parents: [ROOT_SHA], subject: "feat: next" })));
		const markdown = renderReleaseNotes({ target: "v1.0.0", baseline: null, repoUrl: "https://github.com/acme/widget", commits });
		expect(markdown).toContain(`- Add incremental demo deployer ([${ROOT_SHA.slice(0, 7)}](https://github.com/acme/widget/commit/${ROOT_SHA}))`);
	});
});

describe("baseline selection", () => {
	test("picks the highest release that is older than the target", () => {
		const releases = [release("v3.0.0"), release("v1.10.0"), release("v1.2.0")];
		expect(selectBaseline("v2.0.0", releases, () => true)).toBe("v1.10.0");
	});

	test("skips the target's own release on a rerun", () => {
		expect(selectBaseline("v2.0.0", [release("v2.0.0"), release("v1.9.0")], () => true)).toBe("v1.9.0");
	});

	test("ignores silent tags, which only exist in git", () => {
		const probed: string[] = [];
		const baseline = selectBaseline("v2.0.0", [release("v1.0.0")], (tag) => {
			probed.push(tag);
			return true;
		});
		// v1.5.0 exists as a tag but has no release, so it is never a candidate and cannot
		// truncate the range down to the v1.5.0..v2.0.0 commits.
		expect(baseline).toBe("v1.0.0");
		expect(probed).toEqual(["v1.0.0"]);
	});

	test("skips releases that are not reachable from the target", () => {
		const releases = [release("v1.5.0"), release("v1.4.0"), release("v1.3.0")];
		expect(selectBaseline("v2.0.0", releases, (tag) => tag !== "v1.5.0")).toBe("v1.4.0");
	});

	test("never probes drafts or non-version tags for reachability", () => {
		const probed: string[] = [];
		const baseline = selectBaseline(
			"v2.0.0",
			[release("v2.5.0", { isDraft: true }), release("nightly"), release("v1.0.0")],
			(tag) => {
				probed.push(tag);
				return true;
			},
		);
		expect(baseline).toBe("v1.0.0");
		expect(probed).toEqual(["v1.0.0"]);
	});

	test("treats prereleases as published predecessors", () => {
		expect(selectBaseline("v1.0.0", [release("v1.0.0-rc.2"), release("v1.0.0-rc.1"), release("v0.9.0")], () => true)).toBe("v1.0.0-rc.2");
		expect(selectBaseline("v1.0.0-rc.2", [release("v1.0.0-rc.1")], () => true)).toBe("v1.0.0-rc.1");
	});

	test("returns null without a published predecessor", () => {
		expect(selectBaseline("v1.0.0", [], () => true)).toBeNull();
		expect(selectBaseline("v1.0.0", [release("v1.0.0")], () => true)).toBeNull();
	});

	test("rejects a target that is not a version tag", () => {
		expect(() => selectBaseline("hub-0.5.0", [], () => true)).toThrow(/version tag/);
	});
});

describe("version comparison", () => {
	test("compares numeric parts, not strings", () => {
		expect(compareSemver(version("v1.10.0"), version("v1.2.0"))).toBeGreaterThan(0);
		expect(compareSemver(version("v1.0.0"), version("v1.0.0"))).toBe(0);
	});

	test("orders prereleases below their release and by identifier", () => {
		expect(compareSemver(version("v1.0.0-rc.2"), version("v1.0.0-rc.10"))).toBeLessThan(0);
		expect(compareSemver(version("v1.0.0-rc.1"), version("v1.0.0"))).toBeLessThan(0);
		expect(compareSemver(version("v1.0.0-alpha"), version("v1.0.0-alpha.1"))).toBeLessThan(0);
	});

	test("rejects non-version tags", () => {
		expect(parseSemver("hub-1.0.0")).toBeNull();
		expect(parseSemver("v1.0")).toBeNull();
	});
});

describe("repository detection", () => {
	test("accepts https, ssh, scp, and bare slugs", () => {
		expect(repositoryFromRemote("https://github.com/acme/widget.git")).toBe("acme/widget");
		expect(repositoryFromRemote("ssh://git@github.com/acme/widget.git")).toBe("acme/widget");
		expect(repositoryFromRemote("git@github.com:acme/widget.git")).toBe("acme/widget");
		expect(repositoryFromRemote("acme/widget")).toBe("acme/widget");
	});

	test("rejects local paths and empty remotes", () => {
		expect(repositoryFromRemote("/home/acme/widget")).toBeNull();
		expect(repositoryFromRemote("")).toBeNull();
	});
});

describe("cli", () => {
	test("ranges from the previous release and writes the default output path", async () => {
		const { exec } = world({
			// A rerun has the target's own release in the list; it must not become the baseline.
			releases: [release("v2.0.0"), release("v1.0.0")],
			commits: [record({ sha: FEAT_SHA, subject: "feat(web): tools whitelist" })],
		});
		const { write, writes } = writer();
		const notes = await main(["v2.0.0"], { exec, env: { GITHUB_REPOSITORY: "acme/widget" }, write });

		expect(notes.baseline).toBe("v1.0.0");
		expect(writes[0].path).toBe(DEFAULT_OUTPUT_PATH);
		expect(writes[0].content).toContain("## Features");
		expect(writes[0].content).toContain("tools whitelist");
		expect(writes[0].content).toContain("https://github.com/acme/widget/compare/v1.0.0...v2.0.0");
	});

	test("covers the whole history for a first release, root commit included", async () => {
		const { exec } = world({
			releases: [],
			commits: [
				record({ sha: FEAT_SHA, parents: [ROOT_SHA], subject: "fix(hub): arm the resume plan" }),
				record({ sha: ROOT_SHA, subject: "Add incremental demo deployer" }),
			],
		});
		const { write, writes } = writer();
		const notes = await main(["v1.0.0", "custom.md"], { exec, env: { GITHUB_REPOSITORY: "acme/widget" }, write });

		expect(notes.baseline).toBeNull();
		expect(writes[0].path).toBe("custom.md");
		expect(writes[0].content).toContain(`- Add incremental demo deployer ([${ROOT_SHA.slice(0, 7)}]`);
		expect(writes[0].content).toContain("## Fixes");
		expect(writes[0].content).toEndWith("**Full Changelog**: [v1.0.0](https://github.com/acme/widget/commits/v1.0.0)\n");
	});

	test("walks from an older published release when a newer tag is silent", async () => {
		const { exec } = world({
			releases: [release("v1.0.0")],
			commits: [record({ sha: FEAT_SHA, subject: "feat: after the silent tag" })],
		});
		const notes = await generateTagReleaseNotes({ tag: "v2.0.0", exec, env: { GITHUB_REPOSITORY: "acme/widget" } });
		expect(notes.baseline).toBe("v1.0.0");
	});

	test("skips releases that are not ancestors of the target", async () => {
		const { exec } = world({
			releases: [release("v1.5.0"), release("v1.0.0")],
			unreachableTags: ["v1.5.0"],
			commits: [record({ sha: FEAT_SHA, subject: "feat: thing" })],
		});
		const notes = await generateTagReleaseNotes({ tag: "v2.0.0", exec, env: { GITHUB_REPOSITORY: "acme/widget" } });
		expect(notes.baseline).toBe("v1.0.0");
	});

	test("excludes merges and maintenance commits from the rendered entries", async () => {
		const { exec } = world({
			releases: [release("v1.0.0")],
			commits: [
				record({ sha: FEAT_SHA, parents: [DOC_SHA, ROOT_SHA], subject: "Merge branch 'feat/daemon-restart'" }),
				record({ sha: DOC_SHA, subject: "chore: ignore .omp/" }),
				record({ sha: ROOT_SHA, subject: "feat(hub): cap history list height" }),
			],
		});
		const notes = await generateTagReleaseNotes({ tag: "v2.0.0", exec, env: { GITHUB_REPOSITORY: "acme/widget" } });
		expect(notes.markdown).toContain("cap history list height");
		expect(notes.markdown).not.toContain("Merge branch");
		expect(notes.markdown).not.toContain("ignore .omp");
	});

	test("escapes markdown control characters in generated entries", async () => {
		const { exec } = world({
			releases: [release("v1.0.0")],
			commits: [record({ sha: FEAT_SHA, subject: "fix(web*): keep *emphasis* out of [links] | tables" })],
		});
		const notes = await generateTagReleaseNotes({ tag: "v2.0.0", exec, env: { GITHUB_REPOSITORY: "acme/widget" } });
		expect(notes.markdown).toContain("- **web\\*:** keep \\*emphasis\\* out of \\[links\\] \\| tables");
	});

	test("falls back to the origin remote when GITHUB_REPOSITORY is unset", async () => {
		const { exec } = world({ releases: [], commits: [record({ sha: FEAT_SHA, subject: "feat: thing" })] });
		const notes = await generateTagReleaseNotes({ tag: "v1.0.0", exec, env: {} });
		expect(notes.repoUrl).toBe("https://github.com/acme/widget");
	});

	test("uses GITHUB_SERVER_URL for GitHub Enterprise links", async () => {
		const { exec } = world({ releases: [], commits: [record({ sha: FEAT_SHA, subject: "feat: thing" })] });
		const notes = await generateTagReleaseNotes({
			tag: "v1.0.0",
			exec,
			env: { GITHUB_REPOSITORY: "acme/widget", GITHUB_SERVER_URL: "https://github.example.com/" },
		});
		expect(notes.repoUrl).toBe("https://github.example.com/acme/widget");
	});

	test("fails without writing notes when gh fails", async () => {
		const { exec } = world({ ghError: "gh: HTTP 403: Resource not accessible by integration" });
		const { write, writes } = writer();
		await expect(main(["v2.0.0"], { exec, env: { GITHUB_REPOSITORY: "acme/widget" }, write })).rejects.toThrow(/403/);
		expect(writes).toHaveLength(0);
	});

	test("fails without writing notes when git log fails", async () => {
		const { exec } = world({ releases: [release("v1.0.0")], logError: "fatal: bad revision 'v1.0.0..v2.0.0'" });
		const { write, writes } = writer();
		await expect(main(["v2.0.0"], { exec, env: { GITHUB_REPOSITORY: "acme/widget" }, write })).rejects.toThrow(/bad revision/);
		expect(writes).toHaveLength(0);
	});

	test("fails when the target tag is not in the clone", () => {
		const { exec } = world({ releases: [], missingTags: ["v2.0.0"] });
		expect(() => generateTagReleaseNotes({ tag: "v2.0.0", exec, env: { GITHUB_REPOSITORY: "acme/widget" } })).toThrow(
			/not in this clone/,
		);
	});

	test("fails instead of skipping a candidate tag that cannot be resolved cleanly", () => {
		const { exec } = world({ releases: [release("v1.0.0")], fatalTags: ["v1.0.0"] });
		expect(() => generateTagReleaseNotes({ tag: "v2.0.0", exec, env: { GITHUB_REPOSITORY: "acme/widget" } })).toThrow(
			/git rev-parse v1\.0\.0\^\{commit\} failed: fatal: bad object v1\.0\.0/,
		);
	});

	test("fails when git merge-base errors instead of answering reachability", async () => {
		const { exec } = world({
			releases: [release("v1.0.0")],
			mergeBaseError: "fatal: bad object v1.0.0",
			commits: [record({ sha: FEAT_SHA, subject: "feat: thing" })],
		});
		const { write, writes } = writer();
		await expect(main(["v2.0.0"], { exec, env: { GITHUB_REPOSITORY: "acme/widget" }, write })).rejects.toThrow(/bad object/);
		expect(writes).toHaveLength(0);
	});

	test("rejects missing and extra arguments with the usage line", async () => {
		const { exec } = world({});
		await expect(main([], { exec })).rejects.toThrow(/usage: bun scripts\/release-notes\.ts/);
		await expect(main(["v2.0.0", "out.md", "extra"], { exec })).rejects.toThrow(/usage: bun scripts\/release-notes\.ts/);
	});
});
