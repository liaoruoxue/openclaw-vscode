import * as vscode from "vscode";
import * as crypto from "crypto";
import { GatewayClient } from "./gateway/client";
import { MessageRouter } from "./gateway/router";
import { ChatProvider } from "./vscode/chatProvider";
import { CanvasPanel } from "./vscode/canvasPanel";
import { VSCodeBridge } from "./vscode/bridge";
import { initLogger, log, disposeLogger } from "./vscode/logger";
import type { ConnectionState } from "./gateway/types";

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

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("openclaw");
  bridge = new VSCodeBridge();
  gatewayClient = new GatewayClient();

  // Output Channel
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  log("Extension activated");

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
      vscode.window.showInformationMessage(
        "OpenClaw: Reconnected to Gateway. You may need to resend your last message."
      );
      chatProvider.notifyReconnected();
    }

    if (state === "connected") {
      hasConnectedBefore = true;
    }
    previousState = state;
  });

  // Chat Sidebar
  const chatProvider = new ChatProvider(context.extensionUri, gatewayClient);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("openclaw.chat", chatProvider)
  );

  // Canvas Panel
  const canvasPanel = new CanvasPanel(context.extensionUri);
  canvasPanel.setGateway(gatewayClient);

  // Message Router
  const router = new MessageRouter(chatProvider, canvasPanel, bridge);
  chatProvider.setOnNewRun(() => router.resetSequence());
  gatewayClient.onEvent((event) => {
    router.route(event);
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("openclaw.connect", async () => {
      const url = config.get<string>("gateway.url", "ws://127.0.0.1:18789");
      const token = config.get<string>("gateway.token", "");
      const deviceKeys = getOrCreateDeviceKeys(context.globalState);
      log(`Connecting to ${url}`);
      try {
        await gatewayClient.connect(url, token || undefined, deviceKeys);
        log("Connected successfully");
        vscode.window.showInformationMessage("OpenClaw: Connected to Gateway");
      } catch (err) {
        log(`Connection failed: ${err}`);
        vscode.window.showErrorMessage(
          `OpenClaw: Connection failed — ${err}`
        );
      }
    }),

    vscode.commands.registerCommand("openclaw.disconnect", () => {
      gatewayClient.disconnect();
      log("Disconnected");
      vscode.window.showInformationMessage("OpenClaw: Disconnected");
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
      const prompt = `Here is code from \`${filePath}\` (${lang}):\n\`\`\`${lang}\n${selection}\n\`\`\``;
      chatProvider.sendPrompt(prompt);
    }),

    vscode.commands.registerCommand("openclaw.settings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "openclaw");
    })
  );

  // Auto-connect
  if (config.get<boolean>("autoConnect", false)) {
    vscode.commands.executeCommand("openclaw.connect");
  }
}

export function deactivate() {
  gatewayClient?.disconnect();
  bridge?.dispose();
  disposeLogger();
}
