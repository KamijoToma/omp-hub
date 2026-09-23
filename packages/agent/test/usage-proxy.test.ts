/**
 * usage-proxy loopback relay (docs/protocol.md §2) against a stub stats
 * origin: request shaping, method/path/body guards, and the response cap.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { StatsOriginResolver } from "../src/usage-proxy";
import { createUsageProxy } from "../src/usage-proxy";

interface StubRequest {
	method: string;
	path: string;
	contentType: string | null;
	body: string;
}

const servers: Array<{ stop(): void }> = [];

afterAll(() => {
	for (const server of servers) server.stop();
});

/** One stub dashboard: records the last request, answers from `respond`. */
function stubOrigin(respond: (req: Request) => Response | Promise<Response>): { url: string; last(): StubRequest | undefined } {
	let received: StubRequest | undefined;
	const server = Bun.serve({
		port: 0,
		fetch: async req => {
			const url = new URL(req.url);
			received = {
				method: req.method,
				path: `${url.pathname}${url.search}`,
				contentType: req.headers.get("content-type"),
				body: await req.text(),
			};
			return respond(req);
		},
	});
	servers.push(server);
	const origin = `http://127.0.0.1:${server.port}`;
	return { url: origin, last: () => received };
}

const fixedOrigin = (url: string): StatsOriginResolver => () => Promise.resolve(url);

describe("usage proxy", () => {
	test("relays a GET with query string and decodes to the dashboard reply", async () => {
		const stub = stubOrigin(() => Response.json({ ok: true, totalRequests: 3 }));
		const proxy = createUsageProxy({ resolveOrigin: fixedOrigin(stub.url) });

		const result = await proxy({ t: "usage-req", reqId: "c_aaa", method: "GET", path: "/api/stats?range=24h" });

		expect(result).toMatchObject({
			t: "usage-res",
			reqId: "c_aaa",
			ok: true,
			status: 200,
			contentType: expect.stringContaining("application/json"),
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(JSON.parse(Buffer.from(result.bodyB64!, "base64").toString())).toEqual({ ok: true, totalRequests: 3 });
		expect(stub.last()).toMatchObject({ method: "GET", path: "/api/stats?range=24h", body: "" });
	});

	test("relays a POST body to the dashboard", async () => {
		const stub = stubOrigin(() => Response.json({ processed: 1 }));
		const proxy = createUsageProxy({ resolveOrigin: fixedOrigin(stub.url) });
		const bodyB64 = Buffer.from(JSON.stringify({ forced: true })).toString("base64");

		const result = await proxy({ t: "usage-req", reqId: "c_bbb", method: "POST", path: "/api/sync", bodyB64 });

		expect(result).toMatchObject({ ok: true, status: 200 });
		expect(stub.last()).toMatchObject({
			method: "POST",
			path: "/api/sync",
			contentType: "application/json",
			body: JSON.stringify({ forced: true }),
		});
	});

	test("omits the body for HEAD and empty replies", async () => {
		const head = stubOrigin(() => new Response(null, { status: 200, headers: { "content-type": "text/html" } }));
		const empty = stubOrigin(() => new Response(null, { status: 204 }));
		const headProxy = createUsageProxy({ resolveOrigin: fixedOrigin(head.url) });
		const emptyProxy = createUsageProxy({ resolveOrigin: fixedOrigin(empty.url) });

		const headResult = await headProxy({ t: "usage-req", reqId: "c_ccc", method: "HEAD", path: "/" });
		expect(headResult).toMatchObject({ ok: true, status: 200, contentType: "text/html" });
		expect(headResult.ok && headResult.bodyB64).toBeUndefined();

		const emptyResult = await emptyProxy({ t: "usage-req", reqId: "c_ddd", method: "GET", path: "/" });
		expect(emptyResult).toMatchObject({ ok: true, status: 204 });
		expect(emptyResult.ok && emptyResult.bodyB64).toBeUndefined();
	});

	test("rejects methods outside the allowlist", async () => {
		const proxy = createUsageProxy({ resolveOrigin: () => Promise.resolve("http://127.0.0.1:1") });
		const result = await proxy({ t: "usage-req", reqId: "c_eee", method: "DELETE" as "GET", path: "/api/stats" });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("method not allowed") });
	});

	test("rejects paths that could escape the dashboard origin", async () => {
		const proxy = createUsageProxy({ resolveOrigin: () => Promise.resolve("http://127.0.0.1:1") });
		for (const path of ["api/stats", "//example.com/x", "/\\evil", "/a b\r\nX: 1"]) {
			const result = await proxy({ t: "usage-req", reqId: "c_fff", method: "GET", path });
			expect(result, path).toMatchObject({ ok: false, error: expect.stringContaining("invalid usage path") });
		}
	});

	test("rejects a request body on GET", async () => {
		const proxy = createUsageProxy({ resolveOrigin: () => Promise.resolve("http://127.0.0.1:1") });
		const result = await proxy({
			t: "usage-req",
			reqId: "c_ggg",
			method: "GET",
			path: "/api/stats",
			bodyB64: Buffer.from("{}").toString("base64"),
		});
		expect(result).toMatchObject({ ok: false, error: "request body requires POST" });
	});

	test("fails requests whose response exceeds the relay cap", async () => {
		const stub = stubOrigin(() => new Response("x".repeat(64), { headers: { "content-type": "text/plain" } }));
		const proxy = createUsageProxy({ resolveOrigin: fixedOrigin(stub.url), maxBodyBytes: 8 });

		const result = await proxy({ t: "usage-req", reqId: "c_hhh", method: "GET", path: "/api/stats" });

		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("exceeds 8 bytes") });
	});

	test("reports an unreachable dashboard instead of throwing", async () => {
		const proxy = createUsageProxy({ resolveOrigin: () => Promise.reject(new Error("no sibling checkout")) });
		const result = await proxy({ t: "usage-req", reqId: "c_iii", method: "GET", path: "/api/stats" });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("stats dashboard unavailable: no sibling checkout") });
	});

	test("relays the dashboard's own error status", async () => {
		const stub = stubOrigin(() => new Response("nope", { status: 404 }));
		const proxy = createUsageProxy({ resolveOrigin: fixedOrigin(stub.url) });
		const result = await proxy({ t: "usage-req", reqId: "c_jjj", method: "GET", path: "/api/none" });
		expect(result).toMatchObject({ ok: true, status: 404 });
		expect(result.ok ? Buffer.from(result.bodyB64!, "base64").toString() : "").toBe("nope");
	});
});
