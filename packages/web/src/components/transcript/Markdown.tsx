import katex from "katex";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useRef } from "react";
import "katex/dist/katex.min.css";

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme (javascript:, data:, …)
	return trimmed; // relative / fragment
}

/** Render TeX with KaTeX; fall back to the literal source when KaTeX refuses it. */
function renderMath(tex: string, displayMode: boolean): string {
	try {
		return katex.renderToString(tex, { displayMode, throwOnError: false, strict: "ignore" });
	} catch {
		return escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`);
	}
}

/** First word of a fence info string, lowercased (`" mermaid "` → `mermaid`). */
function fenceLang(lang: string | undefined): string {
	return lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

let mermaidSeq = 0;

/**
 * Render every not-yet-hydrated mermaid placeholder inside `container`.
 * Errors replace the diagram with its source; a pending await after unmount
 * only mutates detached nodes, which is harmless.
 */
async function hydrateMermaids(container: HTMLElement | null): Promise<void> {
	if (!container) return;
	const nodes = container.querySelectorAll<HTMLElement>("[data-mermaid]:not([data-mermaid-done])");
	if (nodes.length === 0) return;
	// Dynamic import is deliberate: mermaid is >1 MB minified and only needed
	// when a transcript actually contains a diagram — static import would put
	// it in the main bundle of every page load.
	const mermaid = (await import("mermaid")).default;
	const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "default";
	for (const node of nodes) {
		const code = node.dataset.mermaid ?? "";
		node.dataset.mermaidDone = "1";
		try {
			mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
			const { svg } = await mermaid.render(`tr-md-mermaid-${++mermaidSeq}`, code);
			node.innerHTML = svg;
		} catch {
			node.classList.add("tr-md-mermaid--err");
			node.textContent = code;
		}
	}
}

/** Custom math token carried through marked's lexer → renderer pipeline. */
interface MathToken extends Tokens.Generic {
	text: string;
}

const mathToken = (type: string, raw: string, text: string): MathToken => ({ type, raw, text });

/**
 * `$$…$$` — renders in display mode. One extension covers both stand-alone
 * blocks and mid-paragraph equations: `[^$]` spans newlines, so a fenced-by-
 * blank-lines `$$` block lexes through the same inline path. (A separate
 * block-level extension registers a `startBlock` hook that stops marked from
 * ever offering the `$$` to the inline tokenizer mid-paragraph.)
 */
const mathDisplayInline = {
	name: "mathDisplayInline",
	level: "inline" as const,
	start(src: string): number | undefined {
		const index = src.indexOf("$$");
		return index < 0 ? undefined : index;
	},
	tokenizer(src: string): MathToken | undefined {
		// No flanking rules here (unlike `$…$`): pandoc-style `$$` display math
		// conventionally sits against newlines on both sides.
		const match = /^\$\$((?:\\.|[^$])+?)\$\$/.exec(src);
		return match ? mathToken("mathDisplayInline", match[0], match[1]) : undefined;
	},
	renderer(token: MathToken): string {
		return renderMath(token.text ?? "", true);
	},
};

/**
 * `$…$` inline math. Delimiters follow the pandoc flanking rules so ordinary
 * dollar amounts survive: opening `$` not followed by whitespace (or another
 * `$`), closing `$` with no whitespace on its left and no digit on its right.
 */
const mathInline = {
	name: "mathInline",
	level: "inline" as const,
	start(src: string): number | undefined {
		const index = src.indexOf("$");
		return index < 0 ? undefined : index;
	},
	tokenizer(src: string): MathToken | undefined {
		const match = /^\$(?!\s|\$)((?:\\.|[^$])+?)(?<!\s)\$(?!\d)/.exec(src);
		return match ? mathToken("mathInline", match[0], match[1]) : undefined;
	},
	renderer(token: MathToken): string {
		return renderMath(token.text ?? "", false);
	},
};

const md = new Marked({
	gfm: true,
	extensions: [mathDisplayInline, mathInline],
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
		code({ text, lang }) {
			const language = fenceLang(lang);
			if (language === "mermaid") {
				// Placeholder div; hydrated to an <svg> by hydrateMermaids after mount.
				return `<div class="tr-md-mermaid" data-mermaid="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
			}
			if (language && hljs.getLanguage(language)) {
				const highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
				return `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}\n</code></pre>`;
			}
			return `<pre><code>${escapeHtml(text)}\n</code></pre>`;
		},
	},
	breaks: true,
});

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => {
		try {
			return md.parse(text, { async: false });
		} catch {
			return `<p>${escapeHtml(text)}</p>`;
		}
	}, [text]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	// Effect deps are the rendered html: re-runs exactly when the inner HTML
	// (and any fresh mermaid placeholders) lands in the DOM.
	useEffect(() => {
		void hydrateMermaids(containerRef.current);
	}, [html]);
	return <div ref={containerRef} className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
