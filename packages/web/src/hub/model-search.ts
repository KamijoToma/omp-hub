/**
 * Query grammar + ranking for the model picker's one search field (omp TUI
 * `model-browser`/`model-selector` parity): raw text fuzzy-filters models,
 * a leading `@` flips the list to role rows, and a trailing `:level` arms a
 * thinking override for the next activation. Blank-query ordering promotes
 * role-assigned models, then per-browser MRU presets; an active query lets
 * text relevance dominate and uses the rest only as tiebreakers (the TUI's
 * `skipRoleRank` rule).
 *
 * Pure logic, no React — the grammar details are unit-tested in
 * `test/model-search.test.ts`.
 */
import type { AgentModel, AgentRole } from "./api";

/** Parsed picker query: role mode, filter text, and the armed thinking level. */
export interface ParsedQuery {
	/** Leading `@` — the list shows role rows instead of models. */
	roleMode: boolean;
	/** Filter text with the `@` prefix and `:level` suffix removed; lowercase. */
	needle: string;
	/** Trailing `:level` matched against `knownLevels` (canonical spelling); absent otherwise. */
	level?: string;
}

/**
 * Split `@text:level` into its parts. The suffix is only stripped when it
 * names a known level — ids like `qwen3:14b` stay literal. The split is also
 * skipped when the whole query is a literal `provider/id` (or bare id) of one
 * of the models, mirroring the TUI guard for ids that genuinely end in a
 * level-looking suffix (`glm-4.7:max`).
 */
export function parseQuery(
	raw: string,
	knownLevels: readonly string[],
	models: readonly Pick<AgentModel, "provider" | "id">[] = [],
): ParsedQuery {
	const roleMode = raw.startsWith("@");
	const body = roleMode ? raw.slice(1) : raw;
	const lowered = body.toLowerCase();

	// Literal `provider/id` / `id` match: never reinterpret its suffix.
	const literal = models.some(model => model.id.toLowerCase() === lowered || `${model.provider}/${model.id}`.toLowerCase() === lowered);
	if (literal) return { roleMode, needle: lowered };

	const colon = lowered.lastIndexOf(":");
	if (colon < 0) return { roleMode, needle: lowered };
	const suffix = lowered.slice(colon + 1);
	const level = knownLevels.find(known => known.toLowerCase() === suffix);
	if (level === undefined) return { roleMode, needle: lowered };
	return { roleMode, needle: lowered.slice(0, colon), level };
}

/** Relevance tier: 0 exact id, 1 prefix, 2 substring, 3 subsequence, -1 no match. */
export function scoreModel(needle: string, model: AgentModel): number {
	if (needle === "") return 0;
	const id = model.id.toLowerCase();
	const qualified = `${model.provider}/${model.id}`.toLowerCase();
	const name = model.name.toLowerCase();
	if (id === needle || qualified === needle || name === needle) return 0;
	if (id.startsWith(needle) || name.startsWith(needle) || wordStarts(id, needle)) return 1;
	if (id.includes(needle) || qualified.includes(needle) || name.includes(needle)) return 2;
	return subsequence(needle, `${qualified} ${name}`) ? 3 : -1;
}

/** True when `needle` matches a run of word-start characters (`gpt4` → `gpt-4o`). */
function wordStarts(haystack: string, needle: string): boolean {
	let at = 0;
	for (let index = 0; index < haystack.length; index++) {
		const start = index === 0 || !isWordChar(haystack[index - 1]!);
		if (start && haystack[index] === needle[at]) {
			at++;
			if (at === needle.length) return true;
		}
	}
	return false;
}

/** Greedy in-order character match (`snt` → `claude-sonnet`). */
function subsequence(needle: string, haystack: string): boolean {
	let at = 0;
	for (const char of haystack) {
		if (char === needle[at]) {
			at++;
			if (at === needle.length) return true;
		}
	}
	return false;
}

function isWordChar(char: string): boolean {
	return /[a-z0-9]/.test(char);
}

/** Role rows matching the needle: subsequence over `role` id and display name. */
export function filterRoles(roles: readonly AgentRole[], needle: string): AgentRole[] {
	if (needle === "") return [...roles];
	return roles.filter(role => subsequence(needle, `${role.role} ${role.name}`.toLowerCase()));
}

/** Ranking inputs derived from the picker's `AgentState` + preset store. */
export interface RankInput {
	/** AgentState.roles — configured (non-auto) assignments promote their models. */
	roles: readonly AgentRole[];
	/** `provider/id` → MRU position (0 = most recent); absent for never-used models. */
	presetIndex: ReadonlyMap<string, number>;
	/** `provider/id` of the session's active model, floated to the top. */
	currentKey: string | null;
}

export interface RankedModel {
	model: AgentModel;
	/** `provider/id`. */
	key: string;
	/** Relevance tier from {@link scoreModel}; 0 when the query is blank. */
	score: number;
}

/**
 * Order models for the flat list: active query first (relevance tiers;
 * non-matching models drop out), then session-current, then configured role
 * assignments in AgentState order, then MRU, then `provider/id` alphabetical.
 * Stable: ties keep the AgentState list order.
 */
export function rankModels(models: readonly AgentModel[], query: ParsedQuery, input: RankInput): RankedModel[] {
	const roleRank = new Map<string, number>();
	input.roles.forEach(role => {
		if (!role.auto && role.model) {
			const key = `${role.model.provider}/${role.model.id}`;
			if (!roleRank.has(key)) roleRank.set(key, roleRank.size);
		}
	});
	const scored = models
		.map(model => {
			const score = scoreModel(query.needle, model);
			return { model, key: `${model.provider}/${model.id}`, score };
		})
		.filter(row => row.score >= 0);
	const currentRank = (key: string): number => (input.currentKey !== null && key === input.currentKey ? 0 : 1);
	return scored
		.map(row => ({
			...row,
			role: roleRank.get(row.key) ?? Number.MAX_SAFE_INTEGER,
			mru: input.presetIndex.get(row.key) ?? Number.MAX_SAFE_INTEGER,
			current: currentRank(row.key),
		}))
		.sort((a, b) =>
			a.score - b.score ||
			a.current - b.current ||
			a.role - b.role ||
			a.mru - b.mru ||
			a.key.localeCompare(b.key),
		)
		.map(({ model, key, score }) => ({ model, key, score }));
}

/**
 * Reverse map `provider/id` → role ids with a configured (non-auto) assignment,
 * AgentState order first. Drives the "serves: smol, plan" badges.
 */
export function rolesByModel(roles: readonly AgentRole[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const role of roles) {
		if (role.auto || !role.model) continue;
		const key = `${role.model.provider}/${role.model.id}`;
		const bucket = map.get(key);
		if (bucket) bucket.push(role.role);
		else map.set(key, [role.role]);
	}
	return map;
}

/** Every level the picker's `:level` grammar accepts, sorted for display. */
export function knownLevels(models: readonly AgentModel[]): string[] {
	const levels = new Set<string>(["off"]);
	for (const model of models) for (const effort of model.thinkingEfforts) levels.add(effort);
	return [...levels].sort();
}
