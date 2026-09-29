import hljs from "highlight.js/lib/common";

/**
 * The vendored tool-render layer reads `globalThis.hljs` (its documented
 * highlighter seam, `tool-render/util.ts getHljs`) and renders plain text
 * when absent. The app bundles highlight.js/common and feeds the seam here,
 * so tool output shares the highlighting the transcript code blocks use.
 */
// globalThis is the seam the vendored tool-render reads (getHljs).
Object.assign(globalThis, { hljs });
