/**
 * Message-search merge helpers behind the session filter boxes (docs/protocol.md
 * §2 `search-sessions` consumers): candidate grouping per machine, and the
 * metadata-plus-message-hits row merge.
 */
import { describe, expect, test } from "bun:test";
import { groupSearchPaths, mergeMessageMatches } from "../src/hub/message-search";

interface Row {
	id: string;
	machineId?: string;
	sessionFile?: string;
}

const keyOf = (row: Row): { machineId: string; path: string } | undefined =>
	row.sessionFile && row.machineId ? { machineId: row.machineId, path: row.sessionFile } : undefined;

describe("groupSearchPaths", () => {
	test("groups candidate paths per machine in first-seen order and deduplicates", () => {
		const rows: Row[] = [
			{ id: "a", machineId: "m1", sessionFile: "/store/a.jsonl" },
			{ id: "b", machineId: "m2", sessionFile: "/store/b.jsonl" },
			{ id: "c", machineId: "m1", sessionFile: "/store/a.jsonl" },
			{ id: "d", machineId: "m1", sessionFile: "/store/c.jsonl" },
		];
		expect(groupSearchPaths(rows, keyOf)).toEqual([
			{ machineId: "m1", paths: ["/store/a.jsonl", "/store/c.jsonl"] },
			{ machineId: "m2", paths: ["/store/b.jsonl"] },
		]);
	});

	test("drops rows without a session file or machine", () => {
		const rows: Row[] = [
			{ id: "a" },
			{ id: "b", machineId: "m1" },
			{ id: "c", sessionFile: "/store/c.jsonl" },
			{ id: "d", machineId: "m1", sessionFile: "" },
		];
		expect(groupSearchPaths(rows, keyOf)).toEqual([]);
	});
});

describe("mergeMessageMatches", () => {
	const rows: Row[] = [
		{ id: "a", sessionFile: "/store/a.jsonl" },
		{ id: "b", sessionFile: "/store/b.jsonl" },
		{ id: "c", sessionFile: "/store/c.jsonl" },
	];
	const pathOf = (row: Row): string | undefined => row.sessionFile;

	test("without hits, the metadata pass passes through", () => {
		const base = [rows[0]!];
		expect(mergeMessageMatches(rows, pathOf, base, null)).toEqual(base);
	});

	test("message-only rows trail the metadata matches; duplicates never appear twice", () => {
		const base = [rows[0]!];
		const matches = {
			"/store/c.jsonl": { path: "/store/c.jsonl", count: 1 },
			"/store/a.jsonl": { path: "/store/a.jsonl", count: 3 },
		};
		expect(mergeMessageMatches(rows, pathOf, base, matches)).toEqual([rows[0], rows[2]]);
	});

	test("rows without a path are unsearchable and never merge in", () => {
		const pathless: Row[] = [{ id: "x" }];
		const matches = {
			"/store/a.jsonl": { path: "/store/a.jsonl", count: 1 },
			"/store/b.jsonl": { path: "/store/b.jsonl", count: 1 },
			"/store/c.jsonl": { path: "/store/c.jsonl", count: 1 },
		};
		expect(mergeMessageMatches([...rows, ...pathless], pathOf, [], matches)).toEqual(rows);
	});
});
