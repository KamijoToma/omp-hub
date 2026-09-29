import { expect, test } from "bun:test";
import { FleetMoveInProgressError, FleetState } from "../src/fleet-state";

test("membership moves wait for accepted worker mutations and reject new ones", async () => {
	const fleet = new FleetState(null);
	const accepted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const order: string[] = [];
	try {
		const first = fleet.mutateWorker("worker", async () => {
			accepted.resolve();
			await release.promise;
			order.push("accepted mutation settled");
		});
		await accepted.promise;
		const moved = fleet.moveSessions(["worker"], () => {
			order.push("membership moved");
		});
		await expect(fleet.mutateWorker("worker", async () => { order.push("revoked mutation"); }))
			.rejects.toBeInstanceOf(FleetMoveInProgressError);
		release.resolve();
		await Promise.all([first, moved]);
		expect(order).toEqual(["accepted mutation settled", "membership moved"]);
		await fleet.mutateWorker("worker", async () => { order.push("new controller mutation"); });
		expect(order.at(-1)).toBe("new controller mutation");
	} finally {
		release.resolve();
		fleet.close();
	}
});

test("pruning a deleted session removes its stale fleet inbox and source receipts", () => {
	const fleet = new FleetState(null);
	try {
		const scope = fleet.createNamespace("short-lived", null);
		fleet.assign("owner", scope.id);
		fleet.assign("discarded", scope.id);
		fleet.watch("owner", "discarded");
		fleet.enqueue({ id: "receipt", sessionId: "discarded", kind: "turn_finished", createdAt: 1 }, () => true);
		expect(fleet.events("owner")).toHaveLength(1);
		expect(fleet.pruneOrphans(new Set(["owner"]))).toBe(1);
		expect(fleet.events("owner")).toEqual([]);
		expect(fleet.snapshot().processedSources).toEqual([]);
	} finally {
		fleet.close();
	}
});
