/**
 * bun build --splitting + an HTML entry emits an <script src> pointing at a
 * fragment chunk instead of the real app entry (bun issue, observed on
 * 1.3.x). The real entry is the only chunk that mounts the SPA root; rewrite
 * the reference to it. Idempotent: when bun emits the correct reference the
 * rewrite is a no-op.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const chunks = readdirSync("dist").filter(f => f.endsWith(".js"));
const entry = chunks.filter(f => readFileSync(`dist/${f}`, "utf8").includes('getElementById("root")'));
if (entry.length !== 1) {
	throw new Error(`SPA root marker matched ${entry.length} chunks, expected exactly 1`);
}
const html = readFileSync("dist/index.html", "utf8");
const scriptTag = /<script type="module" crossorigin src="\/[^"]+\.js"/;
if (!scriptTag.test(html)) {
	throw new Error("entry <script> tag not found in dist/index.html");
}
const fixed = html.replace(scriptTag, `<script type="module" crossorigin src="/${entry[0]}"`);
if (fixed !== html) writeFileSync("dist/index.html", fixed);
console.log(`[fix-html-entry] dist/index.html → /${entry[0]}`);
