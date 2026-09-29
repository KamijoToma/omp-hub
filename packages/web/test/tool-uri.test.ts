import { describe, expect, test } from "bun:test";
import { parseToolPath, procAction } from "../src/tool-render/uri";

describe("parseToolPath — plain paths", () => {
	test("plain file stays raw", () => {
		const p = parseToolPath("src/a.ts");
		expect(p.kind).toBe("file");
		expect(p.scheme).toBeNull();
		expect(p.label).toBe("");
		expect(p.path).toBe("src/a.ts");
		expect(p.sel).toBeNull();
	});

	test("line-range selector splits off", () => {
		const p = parseToolPath("src/a.ts:50-100");
		expect(p.kind).toBe("file");
		expect(p.path).toBe("src/a.ts");
		expect(p.sel).toBe("50-100");
	});

	test("compound selector chain splits off", () => {
		const p = parseToolPath("f.ts:raw:2-4");
		expect(p.path).toBe("f.ts");
		expect(p.sel).toBe("raw:2-4");
	});

	test("empty input degrades to empty file", () => {
		const p = parseToolPath("");
		expect(p.kind).toBe("file");
		expect(p.head).toBe("");
	});
});

describe("parseToolPath — proc://", () => {
	test("bare proc lists jobs", () => {
		const p = parseToolPath("proc://");
		expect(p.kind).toBe("proc");
		expect(p.head).toBe("jobs & services");
		expect(procAction(p)).toBe("list");
	});

	test("job id reads as status target", () => {
		const p = parseToolPath("proc://build-42");
		expect(p.head).toBe("build-42");
		expect(p.tail).toEqual([]);
		expect(procAction(p)).toBe("stdin");
	});

	test("kill subpath", () => {
		const p = parseToolPath("proc://build-42/kill");
		expect(p.head).toBe("build-42");
		expect(p.tail).toEqual(["cancel"]);
		expect(procAction(p)).toBe("cancel");
	});

	test("mode subpath", () => {
		const p = parseToolPath("proc://web/mode");
		expect(procAction(p)).toBe("mode");
	});
});

describe("parseToolPath — doc & device schemes", () => {
	test("xd device with line selector", () => {
		const p = parseToolPath("xd://eval/judge:50-100");
		expect(p.kind).toBe("xd");
		expect(p.head).toBe("eval/judge");
		expect(p.sel).toBe("50-100");
	});

	test("xd bare index", () => {
		expect(parseToolPath("xd://").head).toBe("index");
	});

	test("omp doc", () => {
		const p = parseToolPath("omp://eval/helpers");
		expect(p.kind).toBe("omp");
		expect(p.head).toBe("eval/helpers");
	});

	test("mcp resource keeps the rest verbatim", () => {
		const p = parseToolPath("mcp://server/tools/list");
		expect(p.kind).toBe("mcp");
		expect(p.head).toBe("server/tools/list");
	});

	test("artifact ids render as #n", () => {
		expect(parseToolPath("artifact://12").head).toBe("#12");
	});

	test("history session", () => {
		expect(parseToolPath("history://current").head).toBe("current");
	});

	test("local shared file", () => {
		const p = parseToolPath("local://PLAN.md");
		expect(p.kind).toBe("local");
		expect(p.head).toBe("PLAN.md");
	});

	test("memory namespace and path", () => {
		const p = parseToolPath("memory://root/MEMORY.md");
		expect(p.kind).toBe("memory");
		expect(p.head).toBe("root");
		expect(p.tail).toEqual(["MEMORY.md"]);
	});
});

describe("parseToolPath — agent & cfg", () => {
	test("peer target", () => {
		const p = parseToolPath("agent://Reviewer");
		expect(p.kind).toBe("agent");
		expect(p.head).toBe("Reviewer");
		expect(p.tail).toEqual([]);
	});

	test("broadcast target", () => {
		const p = parseToolPath("agent://all");
		expect(p.tail).toEqual(["broadcast"]);
	});

	test("setting path joins segments", () => {
		const p = parseToolPath("cfg://advisor/model");
		expect(p.kind).toBe("cfg");
		expect(p.head).toBe("advisor.model");
		expect(p.tail).toEqual([]);
	});

	test("save suffix flags persistence", () => {
		const p = parseToolPath("cfg://hub.token/save");
		expect(p.head).toBe("hub.token");
		expect(p.tail).toEqual(["save"]);
		expect(p.fields).toContainEqual(["persist", "config.yml"]);
	});
});

describe("parseToolPath — ssh & web URLs", () => {
	test("remote host and path split", () => {
		const p = parseToolPath("ssh://prod/etc/hosts");
		expect(p.kind).toBe("ssh");
		expect(p.head).toBe("prod");
		expect(p.tail).toEqual(["/etc/hosts"]);
	});

	test("bare ssh lists hosts", () => {
		expect(parseToolPath("ssh://").head).toBe("configured hosts");
	});

	test("ports are not mistaken for selectors", () => {
		const p = parseToolPath("https://example.com:8080/a?b=c");
		expect(p.kind).toBe("url");
		expect(p.head).toBe("example.com:8080");
		expect(p.tail).toEqual(["/a?b=c"]);
		expect(p.sel).toBeNull();
	});
});

describe("parseToolPath — issue/pr", () => {
	test("bare number resolves against default repo", () => {
		const p = parseToolPath("issue://123");
		expect(p.kind).toBe("issue");
		expect(p.head).toBe("#123");
	});

	test("repo-scoped item", () => {
		const p = parseToolPath("pr://owner/repo/12");
		expect(p.kind).toBe("pr");
		expect(p.head).toBe("owner/repo#12");
	});

	test("diff family modes", () => {
		expect(parseToolPath("pr://12/diff").fields).toContainEqual(["view", "changed files"]);
		expect(parseToolPath("pr://12/diff/all").fields).toContainEqual(["view", "full diff"]);
		expect(parseToolPath("pr://12/diff/3").fields).toContainEqual(["view", "file 3"]);
		expect(parseToolPath("pr://owner/repo/12/diff/2").fields).toContainEqual(["view", "file 2"]);
	});

	test("enterprise host is separated from the repo", () => {
		const p = parseToolPath("pr://ghe.example.com/owner/repo/5");
		expect(p.head).toBe("owner/repo#5");
		expect(p.tail).toContain("ghe.example.com");
	});

	test("listing filters surface", () => {
		const p = parseToolPath("issue://owner/repo?state=closed&limit=20");
		expect(p.head).toBe("owner/repo");
		expect(p.tail).toEqual(["state=closed", "limit=20"]);
	});
});

describe("parseToolPath — sqlite & archives", () => {
	test("database table", () => {
		const p = parseToolPath("data.db:users");
		expect(p.kind).toBe("db");
		expect(p.fields).toContainEqual(["table", "users"]);
	});

	test("table plus key row", () => {
		const p = parseToolPath("data.db:users:key1");
		expect(p.fields).toContainEqual(["table", "users"]);
		expect(p.fields).toContainEqual(["key", "key1"]);
	});

	test("query params surface", () => {
		const p = parseToolPath("data.db:users?q=SELECT+1");
		expect(p.tail.join(" ")).toContain("q=SELECT 1");
	});

	test("archive member", () => {
		const p = parseToolPath("/tmp/bundle.tar.gz:src/a.ts");
		expect(p.kind).toBe("archive");
		expect(p.head).toContain("bundle.tar.gz");
		expect(p.tail).toEqual(["src/a.ts"]);
	});
});

describe("parseToolPath — guards", () => {
	test("selectors attach to bare-number authorities", () => {
		const p = parseToolPath("issue://123:raw");
		expect(p.head).toBe("#123");
		expect(p.sel).toBe("raw");
	});

	test("range selector on bare authority splits", () => {
		const p = parseToolPath("artifact://12:50-100");
		expect(p.head).toBe("#12");
		expect(p.sel).toBe("50-100");
	});

	test("opaque URIs stay generic", () => {
		const p = parseToolPath("urn:example:document");
		expect(p.kind).toBe("uri");
		expect(p.scheme).toBe("urn");
	});

	test("windows drive letters are not schemes", () => {
		expect(parseToolPath("C:\\x\\y.ts").kind).toBe("file");
	});

	test("selector-looking tails on plain names still split", () => {
		const p = parseToolPath("Makefile:12");
		expect(p.path).toBe("Makefile");
		expect(p.sel).toBe("12");
	});
});
