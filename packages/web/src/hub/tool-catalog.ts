/**
 * Tool catalog for the start form's whitelist picker (protocol §2 `start.tools`).
 *
 * `packages/web` cannot import the omp SDK (it lives in the agent's
 * dependencies), so this list is a checked-in copy of the SDK's
 * `BUILTIN_TOOL_NAMES` with short UI copy. `packages/agent/test/
 * tool-catalog.test.ts` is the drift guard: it fails when the SDK gains a
 * builtin this catalog does not offer.
 */

export interface ToolCatalogEntry {
	/** Wire name sent as `start.tools` and understood by the SDK. */
	name: string;
	/** SDK tool label. */
	label: string;
	/** One-line picker copy. */
	description: string;
}

/** Picker order: coding essentials first, then navigation/search, then the rest. */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
	{ name: "read", label: "Read", description: "read files, images, and xd:// devices" },
	{ name: "write", label: "Write", description: "create or overwrite files" },
	{ name: "edit", label: "Edit", description: "surgical string replacement in files" },
	{ name: "bash", label: "Bash", description: "run shell commands" },
	{ name: "grep", label: "Grep", description: "regex search across files" },
	{ name: "glob", label: "Glob", description: "find files by glob pattern" },
	{ name: "find", label: "Find", description: "fuzzy file finder" },
	{ name: "lsp", label: "LSP", description: "code intelligence: definitions, references, diagnostics" },
	{ name: "ast_grep", label: "AST Grep", description: "structural pattern search over code" },
	{ name: "ast_edit", label: "AST Edit", description: "structure-aware codemods" },
	{ name: "task", label: "Task", description: "spawn subagent tasks" },
	{ name: "todo", label: "Todo", description: "shared todo list" },
	{ name: "wait", label: "Wait", description: "wait on background jobs" },
	{ name: "web_search", label: "Web Search", description: "search the web" },
	{ name: "github", label: "GitHub", description: "issues, PRs, and repos via gh" },
	{ name: "ask", label: "Ask", description: "interactive choice dialogs (needs a UI guest)" },
	{ name: "debug", label: "Debug", description: "DAP debugger sessions" },
	{ name: "eval", label: "Eval", description: "model-graded eval batches" },
	{ name: "ida", label: "IDA", description: "IDA Pro reverse engineering" },
	{ name: "checkpoint", label: "Checkpoint", description: "session checkpoints" },
	{ name: "rewind", label: "Rewind", description: "restore an earlier session state" },
	{ name: "context_notes", label: "Context Notes", description: "pin notes into context" },
	{ name: "new_context", label: "New Context", description: "branch a fresh context" },
	{ name: "security_scan", label: "Security Scan", description: "vulnerability review" },
	{ name: "memory_edit", label: "Memory Edit", description: "edit memory files" },
	{ name: "retain", label: "Retain", description: "save a memory" },
	{ name: "recall", label: "Recall", description: "search saved memories" },
	{ name: "reflect", label: "Reflect", description: "consolidate memories" },
	{ name: "learn", label: "Learn", description: "extract a reusable skill" },
	{ name: "manage_skill", label: "Manage Skill", description: "list or remove skills" },
];
