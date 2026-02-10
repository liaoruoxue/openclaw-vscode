import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockVSCode } from "../helpers/mock-vscode";

const mockVSCode = createMockVSCode();

// Mock vscode with additional stubs needed for Bridge
vi.mock("vscode", () => ({
  ...mockVSCode,
  EventEmitter: vi.fn(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
  workspace: {
    ...mockVSCode.workspace,
    registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
    openTextDocument: vi.fn().mockResolvedValue({}),
  },
  window: {
    ...mockVSCode.window,
    showTextDocument: vi.fn().mockResolvedValue({
      selection: null,
      revealRange: vi.fn(),
    }),
  },
  Position: vi.fn((line: number, char: number) => ({ line, character: char })),
  Selection: vi.fn((start: unknown, end: unknown) => ({ start, end })),
  Range: vi.fn((start: unknown, end: unknown) => ({ start, end })),
  TextEditorRevealType: { InCenter: 2 },
}));

const { VSCodeBridge } = await import("../../src/vscode/bridge");
const vscode = await import("vscode");

describe("VSCodeBridge", () => {
  let bridge: InstanceType<typeof VSCodeBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new VSCodeBridge();
  });

  describe("showDiff", () => {
    it("should register content provider on construction", () => {
      expect(vscode.workspace.registerTextDocumentContentProvider).toHaveBeenCalledWith(
        "openclaw-diff",
        expect.anything()
      );
    });

    it("should execute vscode.diff command with correct URIs", async () => {
      await bridge.showDiff("original code", "modified code", "test.ts");

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.diff",
        expect.objectContaining({ fsPath: expect.stringContaining("original") }),
        expect.objectContaining({ fsPath: expect.stringContaining("modified") }),
        "OpenClaw Diff: test.ts"
      );
    });

    it("should generate unique URIs for each diff", async () => {
      await bridge.showDiff("a", "b", "first.ts");
      await bridge.showDiff("c", "d", "second.ts");

      expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
      const call1 = (vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls[0];
      const call2 = (vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls[1];
      // Different URI paths (different diff IDs)
      expect(call1[1].fsPath).not.toBe(call2[1].fsPath);
    });
  });

  describe("openFile", () => {
    it("should open a text document and show it", async () => {
      await bridge.openFile("/path/to/file.ts");

      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: "/path/to/file.ts" })
      );
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it("should jump to line when specified", async () => {
      const mockEditor = {
        selection: null as unknown,
        revealRange: vi.fn(),
      };
      (vscode.window.showTextDocument as ReturnType<typeof vi.fn>).mockResolvedValue(mockEditor);

      await bridge.openFile("/path/to/file.ts", 10);

      expect(mockEditor.selection).not.toBeNull();
      expect(mockEditor.revealRange).toHaveBeenCalled();
    });
  });

  describe("runInTerminal", () => {
    it("should create a terminal and send command", async () => {
      const mockTerminal = { show: vi.fn(), sendText: vi.fn(), name: "OpenClaw" };
      (vscode.window.createTerminal as ReturnType<typeof vi.fn>).mockReturnValue(mockTerminal);
      (vscode.window as Record<string, unknown>).terminals = [];

      await bridge.runInTerminal("npm test");

      expect(vscode.window.createTerminal).toHaveBeenCalledWith("OpenClaw");
      expect(mockTerminal.show).toHaveBeenCalled();
      expect(mockTerminal.sendText).toHaveBeenCalledWith("npm test");
    });

    it("should reuse existing OpenClaw terminal", async () => {
      const existingTerminal = { show: vi.fn(), sendText: vi.fn(), name: "OpenClaw" };
      (vscode.window as Record<string, unknown>).terminals = [existingTerminal];

      await bridge.runInTerminal("ls -la");

      expect(vscode.window.createTerminal).not.toHaveBeenCalled();
      expect(existingTerminal.sendText).toHaveBeenCalledWith("ls -la");
    });
  });

  describe("notification methods", () => {
    it("showInfo should call showInformationMessage", () => {
      bridge.showInfo("hello");
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("hello");
    });

    it("showWarning should call showWarningMessage", () => {
      bridge.showWarning("careful");
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("careful");
    });

    it("showError should call showErrorMessage", () => {
      bridge.showError("oops");
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("oops");
    });
  });

  describe("getWorkspacePath", () => {
    it("should return the first workspace folder path", () => {
      const path = bridge.getWorkspacePath();
      expect(path).toBe("/test/workspace");
    });
  });

  describe("dispose", () => {
    it("should not throw on dispose", () => {
      expect(() => bridge.dispose()).not.toThrow();
    });
  });
});
