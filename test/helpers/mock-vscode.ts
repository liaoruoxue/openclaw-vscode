import { vi } from "vitest";

/**
 * Minimal VS Code API stubs for testing extension code outside of VS Code.
 *
 * Usage in tests:
 *   vi.mock("vscode", () => createMockVSCode());
 *
 * Access tracked calls via the returned object, e.g.:
 *   const mock = createMockVSCode();
 *   // after running code that calls vscode.window.showInformationMessage(...)
 *   expect(mock.window.showInformationMessage).toHaveBeenCalledWith("hello");
 */
export function createMockVSCode() {
  const mockWebviewView: MockWebviewView = {
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn((cb) => {
        // Store the callback so tests can invoke it
        mockWebviewView._onMessageCallback = cb;
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn().mockResolvedValue(true),
      asWebviewUri: vi.fn((uri) => uri),
      cspSource: "https://test.csp",
    },
    _onMessageCallback: undefined as ((msg: unknown) => void) | undefined,
  };

  const mockWebviewPanel: MockWebviewPanel = {
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn((cb) => {
        mockWebviewPanel._onMessageCallback = cb;
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn().mockResolvedValue(true),
      asWebviewUri: vi.fn((uri) => uri),
      cspSource: "https://test.csp",
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn((cb) => {
      mockWebviewPanel._onDisposeCallback = cb;
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
    _onMessageCallback: undefined as ((msg: unknown) => void) | undefined,
    _onDisposeCallback: undefined as (() => void) | undefined,
  };

  const vscode = {
    Uri: {
      file: vi.fn((path: string) => ({ fsPath: path, scheme: "file" })),
      parse: vi.fn((str: string) => ({ fsPath: str, scheme: "untitled" })),
      joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({
        fsPath: parts.join("/"),
        scheme: "file",
      })),
    },

    ViewColumn: {
      One: 1,
      Two: 2,
      Beside: -2,
    },

    window: {
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      createWebviewPanel: vi.fn(() => mockWebviewPanel),
      activeTextEditor: undefined as unknown,
      terminals: [] as unknown[],
      createTerminal: vi.fn(() => ({
        show: vi.fn(),
        sendText: vi.fn(),
        name: "OpenClaw",
      })),
      showTextDocument: vi.fn(),
    },

    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultVal?: unknown) => defaultVal),
      })),
      workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
    },

    commands: {
      registerCommand: vi.fn((_cmd: string, cb: Function) => {
        return { dispose: vi.fn(), _callback: cb };
      }),
      executeCommand: vi.fn(),
    },

    CancellationTokenSource: vi.fn(() => ({
      token: { isCancellationRequested: false },
      cancel: vi.fn(),
      dispose: vi.fn(),
    })),

    // Expose mock internals for test assertions
    _mockWebviewView: mockWebviewView,
    _mockWebviewPanel: mockWebviewPanel,
  };

  return vscode;
}

export interface MockWebviewView {
  webview: {
    options: unknown;
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    asWebviewUri: ReturnType<typeof vi.fn>;
    cspSource: string;
  };
  _onMessageCallback?: (msg: unknown) => void;
}

export interface MockWebviewPanel {
  webview: {
    options: unknown;
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    asWebviewUri: ReturnType<typeof vi.fn>;
    cspSource: string;
  };
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  _onMessageCallback?: (msg: unknown) => void;
  _onDisposeCallback?: () => void;
}

export type MockVSCode = ReturnType<typeof createMockVSCode>;
