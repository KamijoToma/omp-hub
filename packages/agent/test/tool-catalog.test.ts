/**
 * Drift guard for the web start-form tool picker (protocol §2 `start.tools`).
 *
 * `packages/web` cannot import the omp SDK (it is the agent's dependency, not
 * installed for web), so `packages/web/src/hub/tool-catalog.ts` is a checked-in
 * copy of `BUILTIN_TOOL_NAMES`. This test fails when the SDK gains or drops a
 * builtin tool so the catalog cannot silently drift.
 */

import { expect, test } from "bun:test";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { TOOL_CATALOG } from "../../web/src/hub/tool-catalog";

test("web tool picker catalog covers exactly the SDK's builtin tool names", () => {
	expect(TOOL_CATALOG.map(tool => tool.name).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
});
