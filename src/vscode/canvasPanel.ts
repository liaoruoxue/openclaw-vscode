import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/client";
import { log } from "./logger";

/**
 * v0.8 messages are plain objects with action keys
 * (surfaceUpdate, beginRendering, dataModelUpdate, deleteSurface).
 */
type V08Message = Record<string, unknown>;

interface PendingEval {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CanvasPanel {
  private panel: vscode.WebviewPanel | null = null;
  private pendingMessages: V08Message[][] = [];
  private gateway: GatewayClient | null = null;
  private webviewReady = false;
  private evalCounter = 0;
  private pendingEvals: Map<string, PendingEval> = new Map();

  constructor(private extensionUri: vscode.Uri) {}

  setGateway(gateway: GatewayClient): void {
    this.gateway = gateway;
  }

  reveal(extensionUri?: vscode.Uri): void {
    if (this.panel) {
      log(`[canvas] reveal(): panel already exists, just revealing`);
      this.panel.reveal();
      return;
    }

    log(`[canvas] reveal(): creating new panel`);
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

    const bundleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(uri, "dist", "webview", "a2ui.bundle.js")
    );
    const csp = this.panel.webview.cspSource;
    this.panel.webview.html = this.getHtml(bundleUri.toString(), csp);

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        this.webviewReady = true;
        log(`[canvas] Webview ready. Flushing ${this.pendingMessages.length} pending batch(es)`);
        for (const batch of this.pendingMessages) {
          this.panel?.webview.postMessage({ type: "a2ui.applyMessages", messages: batch });
        }
        this.pendingMessages = [];
        return;
      }
      if (msg.type === "evalResult") {
        const pending = this.pendingEvals.get(msg.id);
        if (pending) {
          this.pendingEvals.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(String(msg.error)));
          } else {
            pending.resolve(String(msg.result ?? ""));
          }
        }
        return;
      }
      if (msg.type === "userAction") {
        this.handleUserAction(msg);
        return;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.webviewReady = false;
      // Reject all pending evals
      for (const [, pending] of this.pendingEvals) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Panel disposed"));
      }
      this.pendingEvals.clear();
    });
  }

  /**
   * Evaluate JavaScript in the canvas webview and return the result.
   */
  evalJs(javaScript: string, timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.panel || !this.webviewReady) {
        reject(new Error("Canvas not ready"));
        return;
      }
      const id = `eval_${++this.evalCounter}`;
      const timer = setTimeout(() => {
        this.pendingEvals.delete(id);
        reject(new Error("eval timed out"));
      }, timeoutMs);
      this.pendingEvals.set(id, { resolve, reject, timer });
      this.panel.webview.postMessage({ type: "eval", id, javaScript });
    });
  }

  /**
   * Capture a snapshot of the canvas webview as a base64-encoded image.
   */
  snapshot(format: string = "png", timeoutMs = 15_000): Promise<{ base64: string; format: string }> {
    return new Promise((resolve, reject) => {
      if (!this.panel || !this.webviewReady) {
        reject(new Error("Canvas not ready"));
        return;
      }
      const id = `eval_${++this.evalCounter}`;
      const timer = setTimeout(() => {
        this.pendingEvals.delete(id);
        reject(new Error("snapshot timed out"));
      }, timeoutMs);
      this.pendingEvals.set(id, {
        resolve: (result) => resolve({ base64: result, format }),
        reject,
        timer,
      });
      this.panel.webview.postMessage({ type: "snapshot", id, format });
    });
  }

  /**
   * Post v0.8 messages to the canvas webview.
   * Messages should be already converted to v0.8 format by the caller.
   */
  postV08Messages(messages: V08Message[]): void {
    if (messages.length === 0) return;
    log(`[canvas] postV08Messages: ${messages.length} message(s), panel=${!!this.panel} ready=${this.webviewReady}`);
    if (this.panel && this.webviewReady) {
      this.panel.webview.postMessage({ type: "a2ui.applyMessages", messages });
    } else {
      this.pendingMessages.push(messages);
      if (!this.panel) {
        this.reveal();
      }
    }
  }

  /** @deprecated Use postV08Messages instead — kept for backward compatibility during migration */
  postA2UIMessage(message: Record<string, unknown>): void {
    this.postV08Messages([message]);
  }

  private handleUserAction(msg: { type: string; [key: string]: unknown }): void {
    if (!this.gateway) return;
    const sessionKey = this.gateway.sessionKey;
    if (!sessionKey) return;

    const userAction = msg.userAction as Record<string, unknown> | undefined;
    if (!userAction) return;

    log(`[canvas] User action: ${JSON.stringify(userAction).slice(0, 200)}`);
    this.gateway.chatSend(sessionKey, JSON.stringify({
      type: "a2ui_action",
      ...userAction,
    })).catch((err) => {
      log(`[canvas] Failed to send user action: ${err}`);
    });
  }

  private getHtml(bundleSrc: string, csp: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en" data-platform="vscode">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${csp} 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: https:;">
  <title>OpenClaw Canvas</title>
  <style>
    :root { color-scheme: dark; }
    html, body { height: 100%; margin: 0; }
    body {
      font: 14px var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #e5e7eb);
      overflow: hidden;
    }
    openclaw-a2ui-host {
      display: block;
      height: 100%;
      --openclaw-a2ui-inset-top: 8px;
      --openclaw-a2ui-inset-right: 8px;
      --openclaw-a2ui-inset-bottom: 8px;
      --openclaw-a2ui-inset-left: 8px;
      --openclaw-a2ui-status-top: calc(50% - 18px);
      --openclaw-a2ui-empty-top: 18px;
    }
  </style>
</head>
<body>
  <openclaw-a2ui-host></openclaw-a2ui-host>
  <script>
    // Shim native bridge so bootstrap.js can post actions via VS Code messaging
    (function() {
      const vscode = acquireVsCodeApi();
      globalThis.openclawCanvasA2UIAction = {
        postMessage: function(msg) {
          var parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
          vscode.postMessage({ type: "userAction", userAction: parsed.userAction || parsed });
        }
      };
      globalThis.__openclawVscode = vscode;
    })();
  </script>
  <script type="module" src="${bundleSrc}"></script>
  <script>
    // --- VS Code message bridge ---
    (function() {
      var vscode = globalThis.__openclawVscode;

      function waitForA2UI(cb) {
        var done = false;
        function fire() { if (done) return; done = true; clearInterval(iv); cb(); }
        if (globalThis.openclawA2UI) { fire(); return; }
        var iv = setInterval(function() {
          if (globalThis.openclawA2UI) { fire(); }
        }, 50);
        setTimeout(fire, 10000);
      }

      waitForA2UI(function() {
        vscode.postMessage({ type: "ready" });
      });

      window.addEventListener("message", function(e) {
        var msg = e.data;
        if (!msg) return;

        if (msg.type === "a2ui.applyMessages" && globalThis.openclawA2UI) {
          try {
            globalThis.openclawA2UI.applyMessages(msg.messages);
          } catch (err) {
            console.error("[a2ui bridge] applyMessages failed:", err);
          }
        } else if (msg.type === "a2ui.reset" && globalThis.openclawA2UI) {
          globalThis.openclawA2UI.reset();
        } else if (msg.type === "eval") {
          // Execute arbitrary JS from canvas.eval command
          try {
            var fn = new Function(msg.javaScript);
            var result = fn();
            // Handle promise results
            if (result && typeof result.then === "function") {
              result.then(function(v) {
                vscode.postMessage({ type: "evalResult", id: msg.id, result: v == null ? "" : String(v) });
              }).catch(function(err) {
                vscode.postMessage({ type: "evalResult", id: msg.id, error: String(err) });
              });
            } else {
              vscode.postMessage({ type: "evalResult", id: msg.id, result: result == null ? "" : String(result) });
            }
          } catch (err) {
            vscode.postMessage({ type: "evalResult", id: msg.id, error: String(err) });
          }
        } else if (msg.type === "snapshot") {
          // Capture the canvas or body as a base64 image
          try {
            var fmt = msg.format === "jpeg" ? "image/jpeg" : "image/png";
            // Try to find an HTML canvas element first
            var cvs = document.querySelector("canvas");
            if (cvs) {
              var dataUrl = cvs.toDataURL(fmt);
              var base64 = dataUrl.split(",")[1] || "";
              vscode.postMessage({ type: "evalResult", id: msg.id, result: base64 });
            } else {
              vscode.postMessage({ type: "evalResult", id: msg.id, error: "no canvas element found" });
            }
          } catch (err) {
            vscode.postMessage({ type: "evalResult", id: msg.id, error: String(err) });
          }
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
