import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { getSubscriptions } from "../src/subscriptions";
import { projectSubscriptions } from "../src/subscriptions-worker";

test("projects live quotas without exposing SDK raw payload, scope identities, or metadata", () => {
	const report = {
		provider: "anthropic", fetchedAt: 1000,
		metadata: { email: "user@example.com", orgName: "Workspace", secret: "credential metadata" },
		raw: { access_token: "raw provider secret" },
		limits: [{ id: "5h", label: "5 Hour", scope: { provider: "anthropic", accountId: "scope-secret" },
			amount: { unit: "percent", usedFraction: 0.25, remainingFraction: 0.75 },
			window: { id: "5h", label: "5 Hour", resetsAt: 9000 }, status: "ok", notes: ["limited"] }],
		resetCredits: { availableCount: 2, redeemableCount: 1, nextCreditId: "private-id", credits: [{ id: "private-credit" }] },
	} as UsageReport;
	const unavailable = [{ provider: "other", account: "API key", raw: "do not expose" }];
	const usage = projectSubscriptions([report], unavailable, 1200);
	expect(usage).toEqual({ fetchedAt: 1200, reports: [{ provider: "anthropic", account: "user@example.com · Workspace",
		fetchedAt: 1000, limits: [{ id: "5h", label: "5 Hour", amount: { unit: "percent", usedFraction: 0.25,
			remainingFraction: 0.75 }, window: { id: "5h", label: "5 Hour", resetsAt: 9000 }, status: "ok", notes: ["limited"] }],
		resetCredits: { availableCount: 2, redeemableCount: 1 } }], unavailable: [{ provider: "other", account: "API key" }] });
	expect(JSON.stringify(usage)).not.toContain("secret");
	expect(JSON.stringify(usage)).not.toContain("private");
});

test("rejects invalid and nonexistent named profiles before launching an SDK worker", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "quota-profiles-"));
	try {
		await mkdir(path.join(root, "work", "agent"), { recursive: true });
		for (const raw of ["", " work ", "../work", "CON", "work.", 3]) {
			await expect(getSubscriptions(raw, root)).rejects.toThrow("invalid profile name");
		}
		await expect(getSubscriptions("missing", root)).rejects.toThrow("profile not found");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

