/**
 * omp profile name validation for the hub API (docs/protocol.md §2/§3).
 *
 * The hub never touches profile directories — discovery and existence live on
 * the agent (`packages/agent/src/profiles.ts` mirrors omp's pi-utils there).
 * This copy of the name rules exists so a bad `POST /api/sessions` profile
 * fails with 400 before a session record is created, instead of surfacing
 * later as a `session-error` on the machine.
 */

/** omp profile charset (pi-utils `PROFILE_NAME_RE`). */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Windows reserves these device names as basenames and `NAME.<anything>`
 * (pi-utils `WINDOWS_RESERVED_BASENAME_RE`); matching omp keeps hub-side
 * rejection identical to `--profile` validation.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Validate `raw` as a selectable profile name. `"default"` and blank mean the
 * implicit default profile (`undefined`); anything else must match omp's name
 * rules, and a violation throws with omp's message shape.
 */
export function normalizeProfileName(raw: string | undefined): string | undefined {
	const normalized = raw?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${raw}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name.`,
		);
	}
	return normalized;
}
