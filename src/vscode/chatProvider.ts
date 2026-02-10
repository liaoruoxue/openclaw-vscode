import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/client";
import type { AgentEventPayload, ConnectionState, Session } from "../gateway/types";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: Record<string, unknown>) => p?.type === "text")
      .map((p: Record<string, unknown>) => (p.text as string) ?? "")
      .join("");
  }
  return "";
}

export function transformHistoryMessage(raw: unknown): Record<string, unknown> {
  const m = raw as Record<string, unknown>;
  const role = (m.role as string) ?? "assistant";
  const content = extractText(m.content);
  const toolCalls: Record<string, unknown>[] = [];
  if (Array.isArray(m.content)) {
    for (const part of m.content as Record<string, unknown>[]) {
      if (part?.type === "tool_use") {
        toolCalls.push({
          id: (part.id as string) ?? crypto.randomUUID(),
          tool: (part.name as string) ?? "unknown",
          title: part.name as string,
          input: part.input,
          done: true,
        });
      }
    }
  }
  return { role, content, toolCalls };
}

export class ChatProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private currentRunId: string | null = null;
  private currentSessionKey: string | null = null;
  private onNewRun: (() => void) | null = null;

  constructor(
    private extensionUri: vscode.Uri,
    private gateway: GatewayClient
  ) {
    // Forward connection state changes to webview
    this.gateway.onStateChange((state) => {
      this.postToWebview({ type: "connection_state", state });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });

    // Send initial state
    this.postToWebview({
      type: "connection_state",
      state: this.gateway.state,
    });
  }

  postEvent(event: AgentEventPayload): void {
    this.view?.webview.postMessage(event);
    if (event.kind === "done") {
      this.currentRunId = null;
    }
  }

  setOnNewRun(callback: () => void): void {
    this.onNewRun = callback;
  }

  sendPrompt(text: string): void {
    this.postToWebview({ type: "inject_prompt", text });
  }

  private postToWebview(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private async handleWebviewMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case "send": {
        const sessionKey =
          this.currentSessionKey ??
          this.gateway.sessionKey ??
          `acp:${crypto.randomUUID()}`;
        this.currentSessionKey = sessionKey;
        try {
          this.onNewRun?.();
          const { runId } = await this.gateway.chatSend(
            sessionKey,
            msg.text as string
          );
          this.currentRunId = runId;
        } catch (err) {
          this.postToWebview({
            type: "error",
            message: `Failed to send: ${err}`,
          });
        }
        break;
      }
      case "abort": {
        if (this.currentRunId && this.currentSessionKey) {
          try {
            await this.gateway.chatAbort(
              this.currentSessionKey,
              this.currentRunId
            );
          } catch {
            // Abort is best-effort
          }
          this.currentRunId = null;
        }
        break;
      }
      case "switch_session": {
        this.currentSessionKey = msg.key as string;
        this.currentRunId = null;
        this.loadHistory(msg.key as string);
        break;
      }
      case "request_sessions": {
        try {
          const sessions = await this.gateway.sessionList();
          this.postToWebview({ type: "sessions", sessions });
        } catch {
          this.postToWebview({ type: "sessions", sessions: [] });
        }
        break;
      }
    }
  }

  private async loadHistory(sessionKey: string): Promise<void> {
    this.postToWebview({ type: "history_loading" });
    try {
      const rawMessages = await this.gateway.chatHistory(sessionKey);
      const messages = rawMessages.map((m) => transformHistoryMessage(m));
      this.postToWebview({ type: "history", messages });
    } catch (err) {
      console.log("[OpenClaw] Failed to load history:", err);
      this.postToWebview({ type: "history", messages: [] });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "chat.js")
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:;">
  <title>OpenClaw Chat</title>
</head>
<body>
  <style>
    .markdown-content { line-height: 1.6; }
    .markdown-content p { margin: 0.5em 0; }
    .markdown-content p:first-child { margin-top: 0; }
    .markdown-content p:last-child { margin-bottom: 0; }
    .markdown-content pre {
      background: var(--vscode-editor-background);
      padding: 12px; border-radius: 4px; overflow: auto;
      font-family: var(--vscode-editor-font-family);
    }
    .markdown-content code {
      background: var(--vscode-editor-background);
      padding: 2px 4px; border-radius: 3px; font-size: 0.9em;
    }
    .markdown-content pre code { background: none; padding: 0; }
    .markdown-content blockquote {
      border-left: 3px solid var(--vscode-panel-border);
      margin: 0.5em 0; padding-left: 12px; opacity: 0.8;
    }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 { margin: 0.8em 0 0.4em; }
    .markdown-content ul, .markdown-content ol { padding-left: 20px; margin: 0.4em 0; }
    .markdown-content a { color: var(--vscode-textLink-foreground); }
    .markdown-content table { border-collapse: collapse; margin: 0.5em 0; }
    .markdown-content th, .markdown-content td {
      border: 1px solid var(--vscode-panel-border); padding: 4px 8px;
    }
    .markdown-content img { max-width: 100%; }
  </style>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
