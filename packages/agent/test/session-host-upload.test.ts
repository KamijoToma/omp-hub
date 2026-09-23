/**
 * `upload-file` write path (docs/protocol.md §2): `writeHubUpload` lands decoded
 * bytes under the machine's temp directory with a sanitized, collision-proof
 * name, refuses oversized/malformed payloads, and prunes stale uploads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOAD_PREFIX, sweepOldUploads, writeHubUpload } from "../src/session-host";

const created: string[] = [];

afterAll(async () => {
	await Promise.all(created.map(path => rm(path, { force: true })));
});

describe("writeHubUpload", () => {
	test("writes decoded bytes to a prefixed tmp file and reports the count", async () => {
		const payload = "%PDF-1.4\nfake-bytes\n";
		const result = await writeHubUpload("report.pdf", Buffer.from(payload).toString("base64"));
		created.push(result.path);

		expect(result.bytes).toBe(Buffer.byteLength(payload));
		expect(result.path.startsWith(tmpdir())).toBe(true);
		expect(result.path).toContain(UPLOAD_PREFIX);
		expect(result.path.endsWith("report.pdf")).toBe(true);

		const info = statSync(result.path);
		expect(info.isFile()).toBe(true);
		// Owner-only: mode 0600.
		expect(info.mode & 0o777).toBe(0o600);
		const onDisk = await Bun.file(result.path).text();
		expect(onDisk).toBe(payload);
	});

	test("sanitizes the client-supplied name down to a bare filename", async () => {
		const result = await writeHubUpload("../../etc/cron.d/evil\npayload", Buffer.from("x").toString("base64"));
		created.push(result.path);

		const name = result.path.split("/").pop()!;
		expect(name.startsWith(UPLOAD_PREFIX)).toBe(true);
		expect(name).not.toContain("/");
		expect(name).not.toContain("\\");
		expect(name).not.toContain("\n");
	});

	test("random suffix keeps same-named uploads distinct", async () => {
		const first = await writeHubUpload("same.bin", Buffer.from("one").toString("base64"));
		const second = await writeHubUpload("same.bin", Buffer.from("two").toString("base64"));
		created.push(first.path, second.path);

		expect(first.path).not.toBe(second.path);
		expect(await Bun.file(first.path).text()).toBe("one");
		expect(await Bun.file(second.path).text()).toBe("two");
	});

	test("refuses missing payloads and reports stable error strings", async () => {
		await expect(writeHubUpload("a.bin", undefined)).rejects.toThrow("upload-file requires dataB64");
		// Input with no valid base64 characters decodes to zero bytes.
		await expect(writeHubUpload("a.bin", "|||||")).rejects.toThrow("invalid upload encoding");
		// Over the 15 MiB cap.
		const oversized = Buffer.alloc(15 * 1024 * 1024 + 1, 1).toString("base64");
		await expect(writeHubUpload("big.bin", oversized)).rejects.toThrow("file too large");
		// A blank name still writes, as "file".
		const unnamed = await writeHubUpload("   ", Buffer.from("x").toString("base64"));
		created.push(unnamed.path);
		expect(unnamed.path.endsWith("file")).toBe(true);
	});
});

describe("stale upload sweep", () => {
	const dir = tmpdir();

	beforeAll(() => {
		// Two aged files and one fresh: the sweep must remove exactly the aged pair.
		for (const [name, age] of [
			[`${UPLOAD_PREFIX}stale-a`, 8 * 24 * 60 * 60 * 1000],
			[`${UPLOAD_PREFIX}stale-b`, 30 * 24 * 60 * 60 * 1000],
			[`${UPLOAD_PREFIX}fresh`, 0],
		] as const) {
			const path = join(dir, name);
			writeFileSync(path, "x");
			utimesSync(path, new Date(), new Date(Date.now() - age));
		}
	});

	test("an upload prunes week-old omp-hub-upload-* files and nothing else", async () => {
		const trigger = await writeHubUpload("sweep-trigger.bin", Buffer.from("x").toString("base64"));
		created.push(trigger.path);

		// Await the exported sweep seam directly: deterministic, no wall-clock polling.
		await sweepOldUploads();

		expect(existsSync(join(dir, `${UPLOAD_PREFIX}stale-a`))).toBe(false);
		expect(existsSync(join(dir, `${UPLOAD_PREFIX}stale-b`))).toBe(false);
		expect(existsSync(join(dir, `${UPLOAD_PREFIX}fresh`))).toBe(true);
		// The surviving fresh file keeps its content (sweep never truncates in place).
		expect(await Bun.file(join(dir, `${UPLOAD_PREFIX}fresh`)).text()).toBe("x");
		expect(await Bun.file(trigger.path).text()).toBe("x");
	});
});
