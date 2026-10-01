import { describe, expect, test } from "bun:test";
import type { AgentModel, AgentRole } from "../src/hub/api";
import { filterRoles, knownLevels, parseQuery, rankModels, rolesByModel, scoreModel } from "../src/hub/model-search";

const model = (provider: string, id: string, name = id, thinkingEfforts: string[] = []): AgentModel => ({
	provider,
	id,
	name,
	thinkingEfforts,
	defaultThinkingLevel: thinkingEfforts.length > 0 ? thinkingEfforts[0]! : null,
});

const CATALOG = [
	model("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", ["low", "medium", "high"]),
	model("openai", "gpt-5.2", "GPT-5.2", ["low", "high"]),
	model("openai", "gpt-5.2-mini", "GPT-5.2 mini"),
	model("zai", "glm-4.7:max", "GLM 4.7 Max", ["off", "low", "medium", "high", "max"]),
	model("qwen", "qwen3:14b", "Qwen3 14B"),
	model("google", "gemini-2.5-pro", "Gemini 2.5 Pro", ["low", "medium", "high"]),
];

const LEVELS = knownLevels(CATALOG);

const roles: AgentRole[] = [
	{ role: "default", name: "Default", model: CATALOG[0]! },
	{ role: "smol", name: "Fast", model: CATALOG[4]!, auto: true },
	{ role: "slow", name: "Thinking", model: CATALOG[3]! },
];

describe("parseQuery", () => {
	test("blank query is a plain empty needle", () => {
		expect(parseQuery("", LEVELS)).toEqual({ roleMode: false, needle: "" });
	});

	test("plain text stays a needle", () => {
		expect(parseQuery("Sonnet", LEVELS)).toEqual({ roleMode: false, needle: "sonnet" });
	});

	test("leading @ flips role mode and strips the prefix", () => {
		expect(parseQuery("@smol", LEVELS)).toEqual({ roleMode: true, needle: "smol" });
	});

	test("trailing known level is stripped and canonicalized", () => {
		expect(parseQuery("sonnet:HIGH", LEVELS)).toEqual({ roleMode: false, needle: "sonnet", level: "high" });
		expect(parseQuery("gpt:off", LEVELS)).toEqual({ roleMode: false, needle: "gpt", level: "off" });
	});

	test("bare :level query keeps an empty needle (thinking-only)", () => {
		expect(parseQuery(":high", LEVELS)).toEqual({ roleMode: false, needle: "", level: "high" });
	});

	test("unknown suffix stays literal — qwen3:14b is an id, not a level", () => {
		expect(parseQuery("qwen3:14b", LEVELS)).toEqual({ roleMode: false, needle: "qwen3:14b" });
	});

	test("colon-bearing id with a level-looking suffix survives the literal-id guard", () => {
		expect(parseQuery("glm-4.7:max", LEVELS, CATALOG)).toEqual({ roleMode: false, needle: "glm-4.7:max" });
		// Any other text with a valid suffix still parses.
		expect(parseQuery("glm:max", LEVELS, CATALOG)).toEqual({ roleMode: false, needle: "glm", level: "max" });
	});

	test("literal bare-id match also guards its suffix", () => {
		expect(parseQuery("qwen3:14b", LEVELS, CATALOG)).toEqual({ roleMode: false, needle: "qwen3:14b" });
	});
});

describe("scoreModel", () => {
	test("blank needle matches everything at tier 0", () => {
		expect(scoreModel("", CATALOG[0]!)).toBe(0);
	});

	test("exact id outranks prefix, prefix outranks substring", () => {
		const gpt = CATALOG[1]!;
		const mini = CATALOG[2]!;
		expect(scoreModel("gpt-5.2", gpt)).toBe(0);
		// Both ids prefix-match `gpt`; the tier only proves prefix beats substring.
		expect(scoreModel("gpt", gpt)).toBe(1);
		expect(scoreModel("mini", mini)).toBe(2);
	});

	test("qualified provider/id is an exact match", () => {
		expect(scoreModel("openai/gpt-5.2", CATALOG[1]!)).toBe(0);
	});

	test("subsequence match lands on tier 3", () => {
		expect(scoreModel("snt", CATALOG[0]!)).toBe(3);
		expect(scoreModel("zzz", CATALOG[0]!)).toBe(-1);
	});

	test("word-start match beats plain subsequence", () => {
		// `gm` matches the word starts of `gpt-5.2-mini` (g…m).
		expect(scoreModel("gm", CATALOG[2]!)).toBe(1);
		expect(scoreModel("gptm", CATALOG[2]!)).toBe(3);
	});
});

describe("rankModels", () => {
	test("blank query: current first, then configured roles, then MRU, then alphabetical", () => {
		const ranked = rankModels(CATALOG, parseQuery("", LEVELS), {
			roles,
			presetIndex: new Map([["google/gemini-2.5-pro", 0]]),
			currentKey: "openai/gpt-5.2",
		});
		expect(ranked.map(row => row.key)).toEqual([
			"openai/gpt-5.2",
			"anthropic/claude-sonnet-4-6",
			"zai/glm-4.7:max",
			"google/gemini-2.5-pro",
			"openai/gpt-5.2-mini",
			"qwen/qwen3:14b",
		]);
	});

	test("auto-assigned roles do not promote their model", () => {
		const ranked = rankModels(CATALOG, parseQuery("", LEVELS), { roles, presetIndex: new Map(), currentKey: null });
		expect(ranked[0]!.key).toBe("anthropic/claude-sonnet-4-6");
		// qwen is smol's auto pick — ranked last, not first.
		expect(ranked.at(-1)!.key).toBe("qwen/qwen3:14b");
	});

	test("active query: relevance dominates, tiebreaks only reorder equals", () => {
		const ranked = rankModels(CATALOG, parseQuery("gpt", LEVELS), {
			roles,
			presetIndex: new Map([["openai/gpt-5.2-mini", 0]]),
			currentKey: "openai/gpt-5.2-mini",
		});
		// Both gpt models are tier 1; the current one still leads within the tier.
		expect(ranked.map(row => row.key)).toEqual(["openai/gpt-5.2-mini", "openai/gpt-5.2"]);
	});

	test("non-matching models drop out under an active query", () => {
		const ranked = rankModels(CATALOG, parseQuery("gemini", LEVELS), { roles, presetIndex: new Map(), currentKey: null });
		expect(ranked).toHaveLength(1);
		expect(ranked[0]!.key).toBe("google/gemini-2.5-pro");
	});
});

describe("filterRoles / rolesByModel / knownLevels", () => {
	test("roles filter by id or name subsequence", () => {
		expect(filterRoles(roles, "").length).toBe(3);
		expect(filterRoles(roles, "slw").map(role => role.role)).toEqual(["slow"]);
		expect(filterRoles(roles, "fast").map(role => role.role)).toEqual(["smol"]);
	});

	test("rolesByModel maps configured assignments only, auto roles skipped", () => {
		const map = rolesByModel(roles);
		expect(map.get("anthropic/claude-sonnet-4-6")).toEqual(["default"]);
		expect(map.get("zai/glm-4.7:max")).toEqual(["slow"]);
		expect(map.has("qwen/qwen3:14b")).toBe(false);
	});

	test("knownLevels unions efforts plus off, sorted", () => {
		expect(LEVELS).toEqual(["high", "low", "max", "medium", "off"]);
	});
});
