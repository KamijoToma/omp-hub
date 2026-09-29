/**
 * Transcript markdown rendering (`Markdown`): KaTeX math (`$…$`, `$$…$$` with
 * currency-amount heuristics), mermaid fence placeholders awaiting async
 * hydration, highlight.js code blocks, and the security floor carried over
 * from the original renderer (raw HTML escaped, `javascript:` links stripped).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/transcript/Markdown";

function render(text: string): string {
	return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("KaTeX math", () => {
	test("inline $…$ renders katex spans", () => {
		const out = render("Kinetic energy $E = mc^2$ applies.");
		expect(out).toContain("katex");
		expect(out).toContain("E = mc^2");
	});

	test("block $$…$$ renders a katex-display block", () => {
		const out = render("$$\n\\frac{a}{b} + c\n$$");
		expect(out).toContain("katex-display");
	});

	test("inline $$…$$ renders display math inside a paragraph", () => {
		const out = render("Euler says $$e^{i\\pi} + 1 = 0$$ indeed.");
		expect(out).toContain("katex-display");
	});

	test("dollar amounts stay literal text", () => {
		const out = render("It costs $5 and $10 today.");
		expect(out).not.toContain("katex");
		expect(out).toContain("$5 and $10");
	});

	test("an unclosed dollar stays literal", () => {
		const out = render("price is $5 today, really");
		expect(out).not.toContain("katex");
	});
});

describe("mermaid fences", () => {
	test("render a placeholder div carrying the escaped source", () => {
		const out = render("```mermaid\ngraph TD; A-->B;\n```");
		expect(out).toContain('class="tr-md-mermaid"');
		expect(out).toContain('data-mermaid="graph TD; A--&gt;B;"');
		expect(out).not.toContain("<pre");
	});

	test("a mermaid fence inside ordinary text flow stays inert until hydration", () => {
		const out = render("before\n\n```mermaid\nflowchart LR\n```\n\nafter");
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).toContain("tr-md-mermaid");
	});
});

describe("code fences", () => {
	test("known languages get hljs tokens", () => {
		const out = render("```ts\nconst answer: number = 42;\n```");
		expect(out).toContain('class="hljs language-ts"');
		expect(out).toContain("hljs-keyword");
	});

	test("unknown languages degrade to plain escaped code", () => {
		const out = render("```weirdlang\na < b & c\n```");
		expect(out).not.toContain("hljs-keyword");
		expect(out).toContain("a &lt; b &amp; c");
	});
});

describe("security floor (unchanged renderer behavior)", () => {
	test("raw html is escaped, never emitted", () => {
		const out = render('<img src=x onerror="alert(1)">');
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img");
	});

	test("javascript: links are stripped of their href", () => {
		const out = render("[click](javascript:alert(1))");
		expect(out).not.toContain('href="javascript:');
	});

	test("https links survive", () => {
		const out = render("[site](https://example.com)");
		expect(out).toContain('href="https://example.com"');
	});

	test("ordinary markdown still renders", () => {
		const out = render("**bold** and `code`");
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("<code>code</code>");
	});
});
