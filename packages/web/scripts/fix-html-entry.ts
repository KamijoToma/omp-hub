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
const referenced = html.match(/<script type="module" crossorigin src="\/([^"]+\.js)"/)?.[1];
if (referenced === entry[0]) {
	// bun emits the correct reference (observed on 1.4+); nothing to rewrite.
	console.log(`[fix-html-entry] dist/index.html already references the entry /${entry[0]}`);
	process.exit(0);
}
const fixed = html.replace(/<script type="module" crossorigin src="\/[^"]+\.js"/, `<script type="module" crossorigin src="/${entry[0]}"`);
if (fixed === html) {
	throw new Error("entry <script> tag not found in dist/index.html");
}
writeFileSync("dist/index.html", fixed);
console.log(`[fix-html-entry] dist/index.html → /${entry[0]}`);
