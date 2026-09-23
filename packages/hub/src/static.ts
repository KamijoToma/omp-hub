/**
 * Static hosting for the built web app (docs/architecture.md §1 static surface):
 * exact file under the dist, else `/index.html` (SPA fallback).
 */
import path from "node:path";
import type { Config } from "./config";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".wasm": "application/wasm",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const NO_CACHE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";
/**
 * Bundler-emitted asset names: `<8 base36 hash>.<ext>` (`bun build …[hash].[ext]`,
 * this repo's web build) or `name-<8+ hex>.<ext>` (vite and friends).
 */
const HASHED_ASSET_RE = /^(?:[0-9a-z]{8}\.[a-z0-9]+|\S*[-.][0-9a-f]{8,}\.[a-z0-9]+)$/i;

/**
 * Bundler hashes mix digits into their letters, while a readable name can be pure base36
 * letters (`manifest.webmanifest` is 8 letters + extension). Requiring a digit keeps the
 * promise short of a year-long cache for names we are only guessing are content-addressed:
 * a false negative merely revalidates, a false positive serves a stale asset forever.
 */
function isHashedAsset(name: string): boolean {
	return HASHED_ASSET_RE.test(name) && /\d/.test(name);
}

function notFound(): Response {
	return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Resolves `relative` inside `root`, or null when it escapes the dist. */
function resolveInside(root: string, relative: string): string | null {
	const target = path.resolve(root, relative);
	if (target === root) return target;
	return target.startsWith(root + path.sep) ? target : null;
}

function fileResponse(file: string, req: Request): Response {
	const headers = new Headers({
		"content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
		// Content-hashed assets are immutable; everything else revalidates (index.html included).
		"cache-control": isHashedAsset(path.basename(file)) ? IMMUTABLE : NO_CACHE,
	});
	if (req.method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(Bun.file(file), { headers });
}

export async function serveStatic(req: Request, cfg: Config): Promise<Response> {
	const pathname = new URL(req.url).pathname;
	// Paths owned by the relay / agent channel / API are never served from dist.
	const reserved =
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname === "/r" ||
		pathname.startsWith("/r/") ||
		pathname === "/agent" ||
		pathname.startsWith("/agent/") ||
		pathname === "/healthz";
	if (reserved) return notFound();
	if (req.method !== "GET" && req.method !== "HEAD") return notFound();

	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return notFound();
	}
	const relative = decoded.replace(/^[/\\]+/, "");
	const exact = relative ? resolveInside(cfg.webDist, relative) : null;
	if (exact && (await Bun.file(exact).exists())) return fileResponse(exact, req);

	const index = resolveInside(cfg.webDist, "index.html");
	if (index && (await Bun.file(index).exists())) return fileResponse(index, req);
	return new Response("web dist not found", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
