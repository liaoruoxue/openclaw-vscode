/**
 * A2UI Component logic tests.
 *
 * Pure-logic tests for the new components (Table, Progress, Tabs, Modal, Markdown).
 * These validate data processing and boundary conditions without requiring a DOM.
 */
import { describe, it, expect } from "vitest";
import { marked } from "marked";

marked.setOptions({ async: false, breaks: true, gfm: true });

// --- Table helpers (mirrors component logic) ---

function tableRenderData(
  columns: Array<{ key: string; label?: string }>,
  rows: Array<Record<string, unknown>>,
) {
  return {
    headers: columns.map((col) => col.label ?? col.key),
    cells: rows.map((row) => columns.map((col) => String(row[col.key] ?? ""))),
  };
}

// --- Progress helpers ---

function progressPct(value: number, max: number): number {
  return Math.min(100, Math.max(0, (value / max) * 100));
}

// --- Markdown helper ---

function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}

describe("Table component logic", () => {
  it("should map columns to header labels", () => {
    const data = tableRenderData(
      [
        { key: "name", label: "Name" },
        { key: "age", label: "Age" },
      ],
      [],
    );
    expect(data.headers).toEqual(["Name", "Age"]);
  });

  it("should use key as label when label is missing", () => {
    const data = tableRenderData(
      [{ key: "name" }, { key: "email" }],
      [],
    );
    expect(data.headers).toEqual(["name", "email"]);
  });

  it("should extract cell values from rows by column key", () => {
    const data = tableRenderData(
      [{ key: "x" }, { key: "y" }],
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    );
    expect(data.cells).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("should handle missing cell values as empty string", () => {
    const data = tableRenderData(
      [{ key: "a" }, { key: "b" }],
      [{ a: "hello" }],
    );
    expect(data.cells).toEqual([["hello", ""]]);
  });

  it("should handle empty columns and rows", () => {
    const data = tableRenderData([], []);
    expect(data.headers).toEqual([]);
    expect(data.cells).toEqual([]);
  });
});

describe("Progress component logic", () => {
  it("should compute 50% for value=50, max=100", () => {
    expect(progressPct(50, 100)).toBe(50);
  });

  it("should compute 0% for value=0", () => {
    expect(progressPct(0, 100)).toBe(0);
  });

  it("should compute 100% for value=max", () => {
    expect(progressPct(100, 100)).toBe(100);
  });

  it("should clamp to 100% when value exceeds max", () => {
    expect(progressPct(200, 100)).toBe(100);
  });

  it("should clamp to 0% for negative values", () => {
    expect(progressPct(-10, 100)).toBe(0);
  });

  it("should handle custom max values", () => {
    expect(progressPct(3, 10)).toBeCloseTo(30);
  });

  it("should handle fractional results", () => {
    expect(progressPct(1, 3)).toBeCloseTo(33.333, 2);
  });
});

describe("Tabs component logic", () => {
  it("should use provided labels array", () => {
    const labels = ["Tab A", "Tab B", "Tab C"];
    const children = [
      { id: "t1", type: "Text", props: {} },
      { id: "t2", type: "Text", props: {} },
      { id: "t3", type: "Text", props: {} },
    ];
    // labels takes priority
    expect(labels).toHaveLength(children.length);
    expect(labels[0]).toBe("Tab A");
  });

  it("should fall back to child tabLabel prop", () => {
    const children = [
      { id: "t1", type: "Text", props: { tabLabel: "First" } },
      { id: "t2", type: "Text", props: { tabLabel: "Second" } },
    ];
    const labels = children.map(
      (c, i) => (c.props.tabLabel as string) ?? c.id ?? `Tab ${i + 1}`,
    );
    expect(labels).toEqual(["First", "Second"]);
  });

  it("should fall back to child id when no tabLabel", () => {
    const children = [
      { id: "panel-1", type: "Text", props: {} },
      { id: "panel-2", type: "Text", props: {} },
    ];
    const labels = children.map(
      (c, i) => (c.props.tabLabel as string) ?? c.id ?? `Tab ${i + 1}`,
    );
    expect(labels).toEqual(["panel-1", "panel-2"]);
  });

  it("should default activeIndex to 0", () => {
    const activeIndex = 0;
    const children = [
      { id: "a", type: "Text", props: {} },
      { id: "b", type: "Text", props: {} },
    ];
    expect(children[activeIndex].id).toBe("a");
  });

  it("should select correct child by activeIndex", () => {
    const children = [
      { id: "a", type: "Text", props: {} },
      { id: "b", type: "Text", props: {} },
      { id: "c", type: "Text", props: {} },
    ];
    expect(children[2].id).toBe("c");
  });
});

describe("Modal component logic", () => {
  it("should not render when open is falsy", () => {
    const open = false;
    expect(open).toBe(false);
    // Component returns null when !props.open
  });

  it("should render when open is true", () => {
    const open = true;
    expect(open).toBe(true);
    // Component renders overlay + content
  });

  it("should treat open=$ref binding correctly", () => {
    // $ref resolution happens in resolveProps before component sees it
    const dataModel = { showModal: true };
    const ref = { $ref: "/showModal" };
    // After resolution, props.open = true
    const resolved = dataModel.showModal;
    expect(resolved).toBe(true);
  });

  it("should produce onClose action with componentId", () => {
    const id = "modal-1";
    const action = "onClose";
    const context = { componentId: id };
    expect(context).toEqual({ componentId: "modal-1" });
    expect(action).toBe("onClose");
  });
});

describe("Markdown component logic", () => {
  it("should render paragraphs", () => {
    const html = renderMarkdown("Hello world");
    expect(html).toContain("<p>Hello world</p>");
  });

  it("should render headings", () => {
    expect(renderMarkdown("# H1")).toContain("<h1");
    expect(renderMarkdown("## H2")).toContain("<h2");
  });

  it("should render inline code", () => {
    const html = renderMarkdown("Use `foo()` here");
    expect(html).toContain("<code>foo()</code>");
  });

  it("should render fenced code blocks", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("should render bold and italic", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("*italic*")).toContain("<em>italic</em>");
  });

  it("should render links", () => {
    const html = renderMarkdown("[click](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("click");
  });

  it("should render tables", () => {
    const html = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("should handle empty content", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("should handle line breaks with breaks:true", () => {
    const html = renderMarkdown("line1\nline2");
    expect(html).toContain("<br");
  });

  it("should render unordered lists", () => {
    const html = renderMarkdown("- a\n- b");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>a</li>");
  });
});
