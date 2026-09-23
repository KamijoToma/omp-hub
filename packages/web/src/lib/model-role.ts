/**
 * Active model-role derivation for the header badge. Mirrors the omp host's
 * own rule (`sessionManager.getLastModelChangeRole` plus its trust rule): the
 * last `model_change` entry on the branch names the role, trusted only while
 * the recorded model is still the session's active model. Everything comes off
 * the collab snapshot, so `/join` guests derive it without hub API access.
 */
import type { SessionEntry, WireModel } from "./wire";

export function activeModelRole(
	entries: readonly SessionEntry[],
	model: WireModel | null | undefined,
): string | null {
	if (!model) return null;
	const active = `${model.provider}/${model.id}`;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "model_change") continue;
		// Same trust rule as the host: a recorded role whose model is no longer
		// the active one is stale. The collab path carries no role→model map to
		// fall back on, so the badge hides instead of guessing.
		return entry.model === active ? (entry.role ?? "default") : null;
	}
	return null;
}
