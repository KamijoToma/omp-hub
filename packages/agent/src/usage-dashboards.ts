/**
 * Named-profile stats dashboards (docs/protocol.md §2 usage relay, 0.5.0+).
 *
 * The stats package pins its database path at module load from the active
 * profile, so one process can never serve two profiles: the daemon's default
 * dashboard is in-process (`usage-proxy.ts`), while every named profile gets
 * a `bun omp-stats --port 0` child spawned with `OMP_PROFILE`/`PI_PROFILE`
 * set — the same env contract the supervisor uses for session hosts. Children
 * are started lazily on first request, cached per profile, and LRU-evicted;
 * an exiting child drops its entry so the next request respawns it.
 */
import { fileURLToPath } from "node:url";

/** Minimal handle of one spawned dashboard child. */
export interface DashboardChild {
	stdout: ReadableStream<Uint8Array>;
	/** Resolves with the exit code when the child dies. */
	exited: Promise<number>;
	kill(): void;
}

/** Spawns one dashboard process for a named profile (loopback, port 0). */
export type DashboardSpawn = (profile: string) => DashboardChild;

/** Live children cap; starting another evicts the least recently used. */
export const MAX_PROFILE_DASHBOARDS = 8;

/**
 * How long a child may take to report its port. The CLI syncs before serving,
 * so a profile's very first start includes a full incremental session scan;
 * the hub's 15 s relay budget may still fire first — the caller retries and
 * lands on the now-warm dashboard.
 */
const PORT_TIMEOUT_MS = 180_000;

/** The CLI's one machine-readable stdout line (`omp-stats` prints it after `startServer`). */
const PORT_PATTERN = /Dashboard available at: (http:\/\/127\.0\.0\.1:\d+)/;

interface DashboardEntry {
	origin: Promise<string>;
	child: DashboardChild;
	lastUse: number;
}

/**
 * Reads stdout until the listen line appears. Kills the child when it takes
 * too long and throws when it dies first or stays silent.
 */
async function readOrigin(child: DashboardChild): Promise<string> {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const timer = setTimeout(() => child.kill(), PORT_TIMEOUT_MS);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			const match = PORT_PATTERN.exec(text);
			if (match) return match[1]!;
		}
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => {});
	}
	const code = await child.exited.catch(() => null);
	throw new Error(`stats dashboard exited (code ${code}) before reporting its port`);
}

/** Default spawn: the pinned `@oh-my-pi/omp-stats` package's CLI entry via this runtime. */
export function spawnDashboard(profile: string): DashboardChild {
	const resolved = import.meta.resolve("@oh-my-pi/omp-stats");
	const entry = resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
	const child = Bun.spawn([process.execPath, entry, "--port", "0"], {
		// The web selection fully determines the child's omp profile: ambient
		// daemon-level OMP_PROFILE/PI_PROFILE never leaks into a profile
		// dashboard (pi-utils/dirs resolves these before any SDK import).
		env: (() => {
			const env: Record<string, string | undefined> = { ...process.env };
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;
			env.OMP_PROFILE = profile;
			env.PI_PROFILE = profile;
			return env;
		})(),
		stdout: "pipe",
		stderr: "inherit",
	});
	return {
		stdout: child.stdout as ReadableStream<Uint8Array>,
		exited: child.exited,
		kill: () => child.kill(),
	};
}

/** Cache of one live dashboard child per named profile. */
export class ProfileDashboards {
	readonly #entries = new Map<string, DashboardEntry>();
	readonly #spawn: DashboardSpawn;
	readonly #capacity: number;
	#clock = 0;

	constructor(spawn: DashboardSpawn = spawnDashboard, options: { capacity?: number } = {}) {
		this.#spawn = spawn;
		this.#capacity = options.capacity ?? MAX_PROFILE_DASHBOARDS;
	}

	/** Monotonic logical time; immune to same-millisecond `Date.now()` ties. */
	#tick(): number {
		return ++this.#clock;
	}

	/**
	 * Origin for one profile; concurrent and repeat callers share the pending
	 * start. A failed start removes itself so the next request respawns.
	 */
	resolve(profile: string): Promise<string> {
		const existing = this.#entries.get(profile);
		if (existing) {
			existing.lastUse = this.#tick();
			return existing.origin;
		}
		const child = this.#spawn(profile);
		const origin: Promise<string> = readOrigin(child);
		const entry: DashboardEntry = { origin, child, lastUse: this.#tick() };
		this.#entries.set(profile, entry);
		this.#evictWhileOverCap(profile);
		void origin.catch(() => {
			if (this.#entries.get(profile) === entry) this.#entries.delete(profile);
		});
		// Unexpected death (crash, oom-kill): drop the entry; the next request
		// respawns. `readOrigin`'s failure path already removed its own entry.
		void child.exited.then(() => {
			if (this.#entries.get(profile) === entry) this.#entries.delete(profile);
		});
		return origin;
	}

	/** Stops one profile's dashboard; a no-op when it is not live. */
	stop(profile: string): void {
		const entry = this.#entries.get(profile);
		if (!entry) return;
		this.#entries.delete(profile);
		try {
			entry.child.kill();
		} catch {
			// A child that already died still resolves `exited`; nothing to do.
		}
	}

	#evictWhileOverCap(protector: string): void {
		while (this.#entries.size > this.#capacity) {
			let oldest: string | null = null;
			for (const key of this.#entries.keys()) {
				if (key === protector) continue;
				if (oldest === null || this.#entries.get(key)!.lastUse < this.#entries.get(oldest)!.lastUse) oldest = key;
			}
			if (oldest === null) break;
			this.stop(oldest);
		}
	}

	/** Kills every live profile dashboard (daemon shutdown). */
	stopAll(): void {
		for (const key of [...this.#entries.keys()]) this.stop(key);
	}
}
