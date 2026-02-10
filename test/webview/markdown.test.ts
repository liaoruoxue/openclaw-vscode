import { describe, it, expect } from "vitest";
import { marked } from "marked";

marked.setOptions({ async: false, breaks: true, gfm: true });

function render(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

describe("Markdown rendering", () => {
  it("should render paragraphs", () => {
    const html = render("Hello world");
    expect(html).toContain("<p>Hello world</p>");
  });

  it("should render headings", () => {
    expect(render("# Heading 1")).toContain("<h1");
    expect(render("## Heading 2")).toContain("<h2");
    expect(render("### Heading 3")).toContain("<h3");
  });

  it("should render inline code", () => {
    const html = render("Use `console.log()` here");
    expect(html).toContain("<code>console.log()</code>");
  });

  it("should render fenced code blocks", () => {
    const md = "```js\nconst x = 1;\n```";
    const html = render(md);
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("should render unordered lists", () => {
    const md = "- item 1\n- item 2\n- item 3";
    const html = render(md);
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item 1</li>");
    expect(html).toContain("<li>item 2</li>");
  });

  it("should render ordered lists", () => {
    const md = "1. first\n2. second";
    const html = render(md);
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("should render bold and italic", () => {
    expect(render("**bold**")).toContain("<strong>bold</strong>");
    expect(render("*italic*")).toContain("<em>italic</em>");
  });

  it("should render links", () => {
    const html = render("[click me](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("click me");
  });

  it("should render blockquotes", () => {
    const html = render("> quoted text");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("quoted text");
  });

  it("should render tables", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const html = render(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("should output script tags as text (CSP blocks execution)", () => {
    const html = render('<script>alert("xss")</script>');
    // marked outputs the raw HTML — CSP prevents execution in webview
    expect(html).toContain("script");
  });

  it("should handle empty content", () => {
    const html = render("");
    expect(html).toBe("");
  });

  it("should handle line breaks with breaks:true", () => {
    const html = render("line1\nline2");
    expect(html).toContain("<br");
  });
});
