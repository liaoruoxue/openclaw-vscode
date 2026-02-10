import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/client";
import type { A2UIMessage } from "../gateway/types";

export class CanvasPanel {
  private panel: vscode.WebviewPanel | null = null;
  private pendingMessages: A2UIMessage[] = [];
  private gateway: GatewayClient | null = null;
  private webviewReady = false;

  constructor(private extensionUri: vscode.Uri) {}

  setGateway(gateway: GatewayClient): void {
    this.gateway = gateway;
  }

  reveal(extensionUri?: vscode.Uri): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const uri = extensionUri ?? this.extensionUri;

    this.panel = vscode.window.createWebviewPanel(
      "openclaw.canvas",
      "OpenClaw Canvas",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(uri, "dist", "webview"),
        ],
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview, uri);

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        this.webviewReady = true;
        for (const m of this.pendingMessages) {
          this.panel?.webview.postMessage({ type: "a2ui", payload: m });
        }
        this.pendingMessages = [];
        return;
      }
      this.handleWebviewMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.webviewReady = false;
    });
  }

  postA2UIMessage(message: A2UIMessage): void {
    if (this.panel && this.webviewReady) {
      this.panel.webview.postMessage({ type: "a2ui", payload: message });
    } else {
      this.pendingMessages.push(message);
      if (!this.panel) {
        this.reveal();
      }
    }
  }

  private handleWebviewMessage(msg: { type: string; [key: string]: unknown }) {
    if (msg.type === "userAction" && this.gateway) {
      const sessionKey = this.gateway.sessionKey;
      const componentId = (msg.context as Record<string, unknown>)?.componentId as string | undefined;
      if (sessionKey) {
        this.gateway.chatSend(sessionKey, JSON.stringify({
          type: "a2ui_action",
          action: msg.action,
          context: msg.context,
        })).then(() => {
          if (componentId) {
            this.panel?.webview.postMessage({
              type: "actionResult",
              componentId,
              status: "success",
            });
          }
        }).catch((err) => {
          if (componentId) {
            this.panel?.webview.postMessage({
              type: "actionResult",
              componentId,
              status: "error",
              message: String(err),
            });
          }
        });
      } else if (componentId) {
        this.panel?.webview.postMessage({
          type: "actionResult",
          componentId,
          status: "error",
          message: "No active session",
        });
      }
    }
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "dist", "webview", "canvas.js")
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https:;">
  <title>OpenClaw Canvas</title>
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
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
