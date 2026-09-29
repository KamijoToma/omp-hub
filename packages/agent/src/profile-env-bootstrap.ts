/**
 * Daemon startup environment sanitation — MUST stay the first import of the
 * daemon entry point.
 *
 * The daemon process is profile-neutral: every piece of profile state it
 * touches is selected explicitly (session starts, subscriptions, usage
 * dashboards), so an ambient OMP_PROFILE/PI_PROFILE/PI_CODING_AGENT_DIR from
 * the launching shell must not define the daemon's own "default" resolution.
 * ESM evaluates imports in order, so running the strip in this module body —
 * before any later import loads the SDK — means pi-utils snapshots a clean
 * environment when it resolves the active profile and agent dir at module
 * load. Without this, in-process default surfaces (machine commands, the
 * in-process default usage dashboard) silently read the ambient profile's
 * data.
 */

import { stripAmbientProfileEnv } from "./profiles";

const removed = stripAmbientProfileEnv();
if (removed.length > 0) {
	console.error(`[omp-hub-agent] stripped ambient profile env: ${removed.join(" ")}`);
}
