import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/client";
import type { A2UIMessage } from "../gateway/types";

export class CanvasPanel {
  private panel: vscode.WebviewPanel | null = null;
  private pendingMessages: A2UIMessage[] = [];
  private gateway: GatewayClient | null = null;

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
      this.handleWebviewMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    // Flush pending messages
    for (const msg of this.pendingMessages) {
      this.panel.webview.postMessage({ type: "a2ui", payload: msg });
    }
    this.pendingMessages = [];
  }

  postA2UIMessage(message: A2UIMessage): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: "a2ui", payload: message });
    } else {
      this.pendingMessages.push(message);
      this.reveal();
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
    content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
  <title>OpenClaw Canvas</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
