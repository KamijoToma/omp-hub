/**
 * ProfileDashboards lifecycle (docs/protocol.md §2 usage relay, 0.5.0+)
 * against fake children: per-profile caching, shared starts, respawn after
 * failure, LRU eviction, and shutdown.
 */
import { describe, expect, test } from "bun:test";
import { ProfileDashboards, type DashboardChild } from "../src/usage-dashboards";

interface FakeChild extends DashboardChild {
	origin: string;
	killCount(): number;
}

/** One child that prints its listen line and runs forever until killed. */
function healthyChild(origin: string): FakeChild {
	let kills = 0;
	return {
		origin,
		stdout: new ReadableStream<Uint8Array>({
			start: controller => controller.enqueue(new TextEncoder().encode(`Synced 0\nDashboard available at: ${origin}\n`)),
		}),
		exited: new Promise<number>(() => {}),
		kill: () => {
			kills += 1;
		},
		killCount: () => kills,
	};
}

/** One child that closes stdout silently and dies before reporting a port. */
function dyingChild(): FakeChild {
	return {
		origin: "",
		stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
		exited: Promise.resolve(1),
		kill: () => {},
		killCount: () => 0,
	};
}

/** Records spawns; `queue` answers them in order (default: healthy on :41000+n). */
function spawnRecorder(queue?: Array<(index: number) => DashboardChild>): {
	children: FakeChild[];
	spawn(profile: string): DashboardChild;
} {
	const children: FakeChild[] = [];
	let index = 0;
	return {
		children,
		spawn(_profile: string): DashboardChild {
			const make = queue?.shift() ?? (() => healthyChild(`http://127.0.0.1:${41000 + index}`));
			const child = make(index) as FakeChild;
			index += 1;
			children.push(child);
			return child;
		},
	};
}

describe("profile dashboards", () => {
	test("caches one child per profile and shares concurrent starts", async () => {
		const recorder = spawnRecorder();
		const dashboards = new ProfileDashboards(recorder.spawn);

		const [a, b, concurrent] = await Promise.all([dashboards.resolve("fast"), dashboards.resolve("fast"), dashboards.resolve("fast")]);
		expect(a).toBe(b);
		expect(a).toBe(concurrent);
		expect(recorder.children).toHaveLength(1);
		expect(await dashboards.resolve("thinking")).not.toBe(a);
		expect(recorder.children).toHaveLength(2);
	});

	test("respawns after a child dies before reporting its port", async () => {
		const recorder = spawnRecorder([() => dyingChild()]);
		const dashboards = new ProfileDashboards(recorder.spawn);

		await expect(dashboards.resolve("fast")).rejects.toThrow(/before reporting its port/);
		await expect(dashboards.resolve("fast")).resolves.toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect(recorder.children).toHaveLength(2);
	});

	test("drops the cache entry when a live child exits unexpectedly", async () => {
		let releases: ((code: number) => void) | undefined;
		const child: FakeChild = {
			...healthyChild("http://127.0.0.1:41500"),
			exited: new Promise<number>(resolve => {
				releases = resolve;
			}),
		};
		const recorder = spawnRecorder([() => child, () => healthyChild("http://127.0.0.1:41501")]);
		const dashboards = new ProfileDashboards(recorder.spawn);

		await expect(dashboards.resolve("fast")).resolves.toBe("http://127.0.0.1:41500");
		releases?.(137);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		await expect(dashboards.resolve("fast")).resolves.toBe("http://127.0.0.1:41501");
		expect(recorder.children).toHaveLength(2);
	});

	test("evicts the least recently used dashboard beyond the capacity", async () => {
		const recorder = spawnRecorder();
		const dashboards = new ProfileDashboards(recorder.spawn, { capacity: 2 });

		await dashboards.resolve("a");
		await dashboards.resolve("b");
		await dashboards.resolve("a"); // touch a → b becomes the LRU
		await dashboards.resolve("c");

		expect(recorder.children).toHaveLength(3);
		expect(recorder.children[1]?.killCount()).toBe(1); // b evicted
		expect(recorder.children[0]?.killCount()).toBe(0); // a survives (touched)
		expect(await dashboards.resolve("a")).toBe(recorder.children[0]?.origin);
	});

	test("stopAll kills every live dashboard exactly once", async () => {
		const recorder = spawnRecorder();
		const dashboards = new ProfileDashboards(recorder.spawn);
		await dashboards.resolve("a");
		await dashboards.resolve("b");

		dashboards.stopAll();
		dashboards.stopAll();
		expect(recorder.children.map(child => child.killCount())).toEqual([1, 1]);
	});
});
