import * as vscode from "vscode";
import * as crypto from "crypto";
import { GatewayClient } from "./gateway/client";
import { NodeConnection } from "./gateway/nodeConnection";
import { MessageRouter } from "./gateway/router";
import { ChatProvider } from "./vscode/chatProvider";
import { CanvasPanel } from "./vscode/canvasPanel";
import { VSCodeBridge } from "./vscode/bridge";
import { initLogger, log, disposeLogger } from "./vscode/logger";
import type { ConnectionState } from "./gateway/types";
import { convertJsonlToV08, convertMessagesToV08, setA2UILogger } from "./gateway/a2uiV08";

const DEVICE_KEYS_KEY = "openclaw.deviceKeys";

interface DeviceKeys {
  publicKey: string;   // hex-encoded raw Ed25519 public key
  privateKey: string;  // hex-encoded DER PKCS8 private key
}

function getOrCreateDeviceKeys(globalState: vscode.Memento): DeviceKeys {
  let keys = globalState.get<DeviceKeys>(DEVICE_KEYS_KEY);
  if (!keys) {
    const pair = crypto.generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
    keys = { publicKey, privateKey };
    globalState.update(DEVICE_KEYS_KEY, keys);
  }
  return keys;
}

let gatewayClient: GatewayClient;
let nodeConnection: NodeConnection;
let bridge: VSCodeBridge;
let statusBarItem: vscode.StatusBarItem;

const STATE_ICONS: Record<ConnectionState, string> = {
  connected: "$(pass-filled)",
  connecting: "$(sync~spin)",
  disconnected: "$(circle-outline)",
  error: "$(error)",
};

const STATE_COLORS: Record<ConnectionState, string | undefined> = {
  connected: undefined,
  connecting: undefined,
  disconnected: undefined,
  error: "statusBarItem.errorBackground",
};

function updateStatusBar(state: ConnectionState): void {
  statusBarItem.text = `${STATE_ICONS[state]} OpenClaw`;
  statusBarItem.tooltip = `OpenClaw: ${state}`;
  statusBarItem.backgroundColor = STATE_COLORS[state]
    ? new vscode.ThemeColor(STATE_COLORS[state]!)
    : undefined;
  statusBarItem.command =
    state === "connected" ? "openclaw.disconnect" : "openclaw.connect";
}

export function validateGatewayUrl(url: string): string | null {
  if (!url) return "Gateway URL is empty";
  if (url.startsWith("http://")) {
    return `URL uses http:// — did you mean ws://${url.slice(7)}?`;
  }
  if (url.startsWith("https://")) {
    return `URL uses https:// — did you mean wss://${url.slice(8)}?`;
  }
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    return `URL must start with ws:// or wss:// (got: ${url})`;
  }
  try {
    new URL(url);
  } catch {
    return `Invalid URL format: ${url}`;
  }
  return null;
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("openclaw");
  bridge = new VSCodeBridge();
  gatewayClient = new GatewayClient();
  nodeConnection = new NodeConnection();

  // Output Channel
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  setA2UILogger(log);
  gatewayClient.setLogger(log);
  log("Extension activated");

  // Chat Sidebar
  const chatProvider = new ChatProvider(context.extensionUri, gatewayClient);
  chatProvider.setLogger(log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("openclaw.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Status Bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  updateStatusBar("disconnected");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  let previousState: ConnectionState = "disconnected";
  let hasConnectedBefore = false;

  gatewayClient.onStateChange((state) => {
    updateStatusBar(state);
    log(`Connection state: ${state}`);

    // Detect reconnection: was disconnected/error, now connected, not the first time
    if (
      state === "connected" &&
      hasConnectedBefore &&
      (previousState === "disconnected" || previousState === "error")
    ) {
      log("Reconnected to Gateway");
      vscode.window.setStatusBarMessage("$(check) OpenClaw: Reconnected", 1500);
      chatProvider.notifyReconnected();
    }

    if (state === "connected") {
      hasConnectedBefore = true;
    }
    previousState = state;
  });

  // Canvas Panel
  const canvasPanel = new CanvasPanel(context.extensionUri);
  canvasPanel.setGateway(gatewayClient);

  // Node connection invoke handler — forward canvas commands to canvas panel
  nodeConnection.onInvoke(async (command, params) => {
    const p = params as Record<string, unknown> | undefined;
    log(`[node.invoke] command=${command} params=${p ? JSON.stringify(p).slice(0, 500) : "(none)"}`);

    switch (command) {
      case "canvas.present":
        log(`[node.invoke] canvas.present url=${(p?.url as string) ?? "(none)"}`);
        canvasPanel.reveal(context.extensionUri);
        return { ok: true };

      case "canvas.hide":
        return { ok: true };

      case "canvas.navigate":
        log(`[node.invoke] canvas.navigate url=${(p?.url as string) ?? "(none)"}`);
        canvasPanel.reveal(context.extensionUri);
        return { ok: true };

      case "canvas.a2ui.push": {
        const messages = (p?.messages as Record<string, unknown>[]) ?? [];
        log(`[node.invoke] a2ui.push: ${messages.length} message(s)`);
        const v08 = convertMessagesToV08(messages);
        log(`[node.invoke] Converted to ${v08.length} v0.8 message(s)`);
        canvasPanel.postV08Messages(v08);
        return { ok: true };
      }

      case "canvas.a2ui.pushJSONL": {
        const jsonl = (p?.jsonl as string) ?? "";
        log(`[node.invoke] a2ui.pushJSONL: ${jsonl.length} chars`);
        const v08 = convertJsonlToV08(jsonl);
        log(`[node.invoke] Converted to ${v08.length} v0.8 message(s)`);
        canvasPanel.postV08Messages(v08);
        return { ok: true };
      }

      case "canvas.a2ui.reset":
        return { ok: true };

      case "canvas.eval": {
        const js = (p?.javaScript as string) ?? "";
        log(`[node.invoke] canvas.eval: ${js.length} chars`);
        canvasPanel.reveal(context.extensionUri);
        try {
          const result = await canvasPanel.evalJs(js);
          return { ok: true, payload: { result } };
        } catch (err) {
          log(`[node.invoke] canvas.eval error: ${err}`);
          return { ok: true, payload: { result: "" } };
        }
      }

      case "canvas.snapshot": {
        const fmt = (p?.format as string) ?? "png";
        log(`[node.invoke] canvas.snapshot format=${fmt}`);
        try {
          const snap = await canvasPanel.snapshot(fmt);
          return { ok: true, payload: { base64: snap.base64, format: snap.format } };
        } catch (err) {
          log(`[node.invoke] canvas.snapshot error: ${err}`);
          return { ok: false, error: `snapshot failed: ${err}` };
        }
      }

      default:
        return { ok: false, error: `unhandled command: ${command}` };
    }
  });

  // Message Router
  const router = new MessageRouter(chatProvider, canvasPanel, bridge);
  router.setLogger(log);
  chatProvider.setOnNewRun(() => router.resetSequence());
  gatewayClient.onEvent((event) => {
    router.route(event);
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("openclaw.connect", async () => {
      const url = config.get<string>("gateway.url", "ws://127.0.0.1:18789");
      const validationError = validateGatewayUrl(url);
      if (validationError) {
        log(`URL validation failed: ${validationError}`);
        vscode.window.showErrorMessage(`OpenClaw: ${validationError}`);
        return;
      }
      const token = config.get<string>("gateway.token", "");
      const deviceKeys = getOrCreateDeviceKeys(context.globalState);
      const deviceId = crypto.createHash("sha256")
        .update(Buffer.from(deviceKeys.publicKey, "hex"))
        .digest("hex");
      log(`Connecting to ${url} (device: ${deviceId})`);
      try {
        await gatewayClient.connect(url, token || undefined, deviceKeys);
        log("Operator connection established");
        // Open parallel node connection for canvas
        try {
          await nodeConnection.connect(url, token || undefined, deviceKeys);
          log("Node connection established");
        } catch (nodeErr) {
          log(`Node connection failed: ${nodeErr}`);
        }
        vscode.window.setStatusBarMessage("$(check) OpenClaw: Connected", 1500);
      } catch (err) {
        log(`Connection failed: ${err}`);
        vscode.window.showErrorMessage(
          `OpenClaw: Connection failed — ${err}`
        );
      }
    }),

    vscode.commands.registerCommand("openclaw.disconnect", () => {
      gatewayClient.disconnect();
      nodeConnection.disconnect();
      log("Disconnected");
      vscode.window.setStatusBarMessage("$(circle-outline) OpenClaw: Disconnected", 1500);
    }),

    vscode.commands.registerCommand("openclaw.openCanvas", () => {
      canvasPanel.reveal(context.extensionUri);
    }),

    vscode.commands.registerCommand("openclaw.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showWarningMessage("OpenClaw: No text selected");
        return;
      }
      const filePath = editor.document.uri.fsPath;
      const lang = editor.document.languageId;
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
      const codeBlock = `\`${filePath}\` (${lang}, ${lineRange}):\n\`\`\`${lang}\n${selection}\n\`\`\``;

      const actions = [
        { label: "Review", prompt: `Review the following code for issues, readability, and best practices.\n\n${codeBlock}` },
        { label: "Refactor", prompt: `Refactor the following code to improve clarity and maintainability.\n\n${codeBlock}` },
        { label: "Add Tests", prompt: `Write unit tests for the following code.\n\n${codeBlock}` },
        { label: "Explain", prompt: `Explain the following code in detail.\n\n${codeBlock}` },
        { label: "Find Bugs", prompt: `Find potential bugs or edge cases in the following code.\n\n${codeBlock}` },
        { label: "Custom...", prompt: "" },
      ];

      const pick = await vscode.window.showQuickPick(
        actions.map((a) => a.label),
        { placeHolder: "What would you like to do with this code?" }
      );
      if (!pick) return;

      const action = actions.find((a) => a.label === pick)!;
      if (pick === "Custom...") {
        chatProvider.sendPrompt(codeBlock);
      } else {
        chatProvider.sendAndExecute(action.prompt);
      }
    }),

    vscode.commands.registerCommand("openclaw.settings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "openclaw");
    }),

    // DEV-ONLY: simulate Gateway events through the full router pipeline
    vscode.commands.registerCommand("openclaw.devTest", async () => {
      const pick = await vscode.window.showQuickPick(
        ["Canvas eval (draw test)", "Canvas snapshot", "A2UI Canvas (all components)", "Diff View", "Terminal Command", "Chat text_delta"],
        { placeHolder: "Select feature to test" }
      );
      if (!pick) return;

      let seq = 1;

      if (pick.startsWith("Canvas eval")) {
        canvasPanel.reveal(context.extensionUri);
        // Wait a moment for webview to be ready
        await new Promise((r) => setTimeout(r, 1500));
        const js = `
          document.body.style.margin='0';
          document.body.style.background='#0b1020';
          var c=document.createElement('canvas');
          c.width=800; c.height=500;
          c.style.display='block';
          document.body.innerHTML='';
          document.body.appendChild(c);
          var ctx=c.getContext('2d');
          var g=ctx.createLinearGradient(0,0,800,500);
          g.addColorStop(0,'#0b1020');
          g.addColorStop(1,'#1a2b6b');
          ctx.fillStyle=g;
          ctx.fillRect(0,0,800,500);
          for(var i=0;i<120;i++){
            ctx.beginPath();
            ctx.arc(Math.random()*800,Math.random()*350,Math.random()*2+0.5,0,Math.PI*2);
            ctx.fillStyle='rgba(255,255,255,'+(Math.random()*0.6+0.4)+')';
            ctx.fill();
          }
          ctx.font='bold 36px sans-serif';
          ctx.fillStyle='#fff';
          ctx.textAlign='center';
          ctx.fillText('Canvas Eval OK',400,280);
          ctx.font='16px sans-serif';
          ctx.fillStyle='#8af';
          ctx.fillText('Rendered inside VS Code webview',400,320);
          'done';
        `;
        try {
          const result = await canvasPanel.evalJs(js);
          log(`[devTest] canvas.eval result: "${result}"`);
          vscode.window.showInformationMessage(`Canvas eval OK: "${result}"`);
        } catch (err) {
          log(`[devTest] canvas.eval error: ${err}`);
          vscode.window.showErrorMessage(`Canvas eval failed: ${err}`);
        }
        return;
      }

      if (pick.startsWith("Canvas snapshot")) {
        try {
          const snap = await canvasPanel.snapshot("png");
          log(`[devTest] snapshot: ${snap.format}, ${snap.base64.length} chars base64`);
          vscode.window.showInformationMessage(`Snapshot OK: ${snap.format}, ${snap.base64.length} chars`);
        } catch (err) {
          log(`[devTest] snapshot error: ${err}`);
          vscode.window.showErrorMessage(`Snapshot failed: ${err}`);
        }
        return;
      }

      if (pick.startsWith("A2UI")) {
        // Send v0.8 format A2UI messages via the router
        router.route({
          type: "event", event: "agent", seq: seq++,
          payload: {
            kind: "a2ui",
            payload: {
              surfaceUpdate: {
                surfaceId: "demo",
                components: [
                  { id: "root", component: { Column: { children: { explicitList: ["title", "body", "sub"] } } } },
                  { id: "title", component: { Text: { text: { literalString: "A2UI Demo" }, usageHint: "h1" } } },
                  { id: "body", component: { Text: { text: { literalString: "This is rendered by the official @a2ui/lit library." }, usageHint: "body" } } },
                  { id: "sub", component: { Text: { text: { literalString: "Running inside VS Code webview." }, usageHint: "caption" } } },
                ],
              },
            },
          },
        } as any);
        router.route({
          type: "event", event: "agent", seq: seq++,
          payload: {
            kind: "a2ui",
            payload: {
              beginRendering: { surfaceId: "demo", root: "root" },
            },
          },
        } as any);
        log("[devTest] Sent v0.8 A2UI messages through router");
      }

      if (pick.startsWith("Diff")) {
        router.route({
          type: "event", event: "agent", seq: seq++,
          payload: {
            kind: "diff",
            path: "src/example.ts",
            original: "function hello() {\n  return 'world';\n}\n",
            modified: "function hello(name: string) {\n  return `Hello, ${name}!`;\n}\n",
          },
        } as any);
        log("[devTest] Sent diff event through router");
      }

      if (pick.startsWith("Terminal")) {
        await bridge.runInTerminal("echo '✅ OpenClaw terminal test successful!'");
        log("[devTest] Ran terminal command through bridge");
      }

      if (pick.startsWith("Chat")) {
        const texts = ["Hello ", "from ", "OpenClaw! ", "This ", "simulates ", "streaming."];
        for (const text of texts) {
          router.route({
            type: "event", event: "agent", seq: seq++,
            payload: { kind: "text_delta", content: text },
          });
          await new Promise((r) => setTimeout(r, 200));
        }
        router.route({
          type: "event", event: "agent", seq: seq++,
          payload: { kind: "done", stopReason: "end_turn" },
        });
        log("[devTest] Sent streaming text_delta events through router");
      }
    })
  );

  // Auto-connect
  if (config.get<boolean>("autoConnect", false)) {
    vscode.commands.executeCommand("openclaw.connect");
  }
}

export function deactivate() {
  gatewayClient?.disconnect();
  nodeConnection?.disconnect();
  bridge?.dispose();
  disposeLogger();
}
