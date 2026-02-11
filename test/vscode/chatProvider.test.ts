import { describe, it, expect, vi } from "vitest";

// Mock vscode before importing chatProvider
vi.mock("vscode", () => ({
  Uri: { joinPath: vi.fn() },
  default: {},
}));

const { transformHistoryMessage } = await import("../../src/vscode/chatProvider");

describe("transformHistoryMessage", () => {
  it("should handle plain string content", () => {
    const result = transformHistoryMessage({
      role: "user",
      content: "Hello world",
    });
    expect(result).toEqual({
      role: "user",
      content: "Hello world",
      toolCalls: [],
      diffs: [],
    });
  });

  it("should handle content-parts array with text", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Here is the answer." },
      ],
    });
    expect(result).toEqual({
      role: "assistant",
      content: "Here is the answer.",
      toolCalls: [],
      diffs: [],
    });
  });

  it("should concatenate multiple text parts", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Part 1. " },
        { type: "text", text: "Part 2." },
      ],
    });
    expect(result.content).toBe("Part 1. Part 2.");
  });

  it("should extract tool_use parts into toolCalls", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Let me read that." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "package.json" },
        },
      ],
    });
    expect(result.content).toBe("Let me read that.");
    const toolCalls = result.toolCalls as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      id: "tool-1",
      tool: "read_file",
      title: "read_file",
      input: { path: "package.json" },
      done: true,
    });
  });

  it("should handle missing role (defaults to assistant)", () => {
    const result = transformHistoryMessage({ content: "no role" });
    expect(result.role).toBe("assistant");
  });

  it("should handle empty content array", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: [],
    });
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  it("should handle non-string non-array content", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: 42,
    });
    expect(result.content).toBe("");
  });

  it("should handle undefined content", () => {
    const result = transformHistoryMessage({ role: "user" });
    expect(result.content).toBe("");
  });

  it("should filter out non-text parts from content extraction", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "image", url: "https://example.com/img.png" },
        { type: "text", text: " world" },
      ],
    });
    expect(result.content).toBe("hello world");
  });

  it("should handle tool_use without id (generates one)", () => {
    const result = transformHistoryMessage({
      role: "assistant",
      content: [
        { type: "tool_use", name: "bash" },
      ],
    });
    const toolCalls = result.toolCalls as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool).toBe("bash");
    expect(typeof toolCalls[0].id).toBe("string");
    expect(toolCalls[0].done).toBe(true);
  });
});
