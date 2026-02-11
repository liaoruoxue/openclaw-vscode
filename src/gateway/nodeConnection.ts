import WebSocket from "ws";
import * as crypto from "crypto";
import { GatewayRequest } from "./types";
import { log } from "../vscode/logger";

type InvokeHandler = (command: string, params: unknown) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
type Disposable = { dispose(): void };

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce?: string;
}): string {
  const version = params.nonce ? "v2" : "v1";
  const parts = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
  ];
  if (version === "v2") {
    parts.push(params.nonce ?? "");
  }
  return parts.join("|");
}

/**
 * Lightweight second WebSocket connection with role:"node".
 * Receives node.invoke.request events from Gateway and replies
 * with node.invoke.result. Used for canvas.present and similar
 * node commands while the main GatewayClient stays as operator.
 */
export class NodeConnection {
  private ws: WebSocket | null = null;
  private invokeHandler: InvokeHandler | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  onInvoke(handler: InvokeHandler): Disposable {
    this.invokeHandler = handler;
    return { dispose: () => { this.invokeHandler = null; } };
  }

  connect(
    url: string,
    token?: string,
    deviceKeys?: { publicKey: string; privateKey: string }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        this.setupHandler(ws, token, deviceKeys, (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        });
      });

      ws.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });

      ws.on("close", () => {
        this._connected = false;
        this.stopHeartbeat();
        if (!settled) { settled = true; reject(new Error("Closed before handshake")); }
      });
    });
  }

  disconnect(): void {
    this.stopHeartbeat();
    this._connected = false;
    if (this.ws) {
      this.ws.close(1000, "Node disconnect");
      this.ws = null;
    }
  }

  private setupHandler(
    ws: WebSocket,
    token: string | undefined,
    deviceKeys: { publicKey: string; privateKey: string } | undefined,
    onReady: (err?: Error) => void,
  ): void {
    let handshakeDone = false;

    const timer = setTimeout(() => {
      if (!handshakeDone) {
        handshakeDone = true;
        onReady(new Error("Node handshake timed out"));
        ws.close();
      }
    }, 10_000);

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(data)); } catch { return; }

      if (!handshakeDone) {
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const nonce = (msg.payload as Record<string, unknown> | undefined)?.nonce as string | undefined;
          this.sendHandshake(ws, token, deviceKeys, nonce);
          return;
        }
        if (msg.type === "res" && msg.id === "connect") {
          handshakeDone = true;
          clearTimeout(timer);
          if (msg.ok === true) {
            this._connected = true;
            this.startHeartbeat(ws);
            onReady();
          } else {
            onReady(new Error(String((msg.error as Record<string, unknown>)?.message ?? msg.error ?? "rejected")));
          }
          return;
        }
      }

      // Handle node.invoke.request
      if (msg.type === "event" && msg.event === "node.invoke.request") {
        const p = msg.payload as Record<string, unknown>;
        log(`[nodeConn] invoke.request: command=${p?.command} id=${p?.id} nodeId=${p?.nodeId}`);
        this.handleInvoke(ws, p);
      } else if (msg.type === "res") {
        // Response to our node.invoke.result — log only failures
        if (msg.ok !== true) {
          log(`[nodeConn] res FAIL id=${msg.id} error=${JSON.stringify(msg.error)}`);
        }
      }
      // Silently ignore broadcast events (agent, chat, health, tick, etc.)
      // — those are for the operator connection
    });
  }

  private sendHandshake(
    ws: WebSocket,
    token: string | undefined,
    deviceKeys: { publicKey: string; privateKey: string } | undefined,
    nonce?: string,
  ): void {
    const clientId = "cli";
    const clientMode = "cli";
    const role = "node";
    const scopes: string[] = [];

    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        version: "0.1.0",
        platform: process.platform,
        mode: clientMode,
      },
      role,
      scopes,
      caps: ["canvas"],
      commands: [
        "canvas.present", "canvas.hide", "canvas.navigate",
        "canvas.eval", "canvas.snapshot",
        "canvas.a2ui.push", "canvas.a2ui.pushJSONL", "canvas.a2ui.reset",
      ],
      permissions: {},
    };

    if (token) {
      params.auth = { token };
    }

    if (deviceKeys) {
      const signedAtMs = Date.now();
      const deviceId = crypto.createHash("sha256")
        .update(Buffer.from(deviceKeys.publicKey, "hex"))
        .digest("hex");
      const payload = buildDeviceAuthPayload({
        deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce,
      });
      const privateKeyObj = crypto.createPrivateKey({
        key: Buffer.from(deviceKeys.privateKey, "hex"),
        format: "der",
        type: "pkcs8",
      });
      const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyObj);
      params.device = {
        id: deviceId,
        publicKey: base64UrlEncode(Buffer.from(deviceKeys.publicKey, "hex")),
        signature: base64UrlEncode(signature),
        signedAt: signedAtMs,
        ...(nonce ? { nonce } : {}),
      };
    }

    const frame: GatewayRequest = {
      type: "req",
      id: "connect",
      method: "connect",
      params,
    };
    ws.send(JSON.stringify(frame));
  }

  private async handleInvoke(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.id as string;
    const command = payload.command as string;
    const paramsJSON = payload.paramsJSON as string | null;
    let params: unknown;
    try {
      params = paramsJSON ? JSON.parse(paramsJSON) : undefined;
    } catch (err) {
      log(`[nodeConn] Failed to parse paramsJSON for ${command}: ${err}`);
      params = undefined;
    }
    log(`[nodeConn] handleInvoke: command=${command} requestId=${requestId} hasParams=${params != null}`);

    let result: { ok: boolean; payload?: unknown; error?: string };
    if (this.invokeHandler) {
      try {
        result = await this.invokeHandler(command, params);
      } catch (err) {
        result = { ok: false, error: String(err) };
      }
    } else {
      result = { ok: false, error: `no handler for ${command}` };
    }

    const response: GatewayRequest = {
      type: "req",
      id: `invoke_res_${requestId}`,
      method: "node.invoke.result",
      params: {
        id: requestId,
        nodeId: payload.nodeId,
        ok: result.ok,
        payloadJSON: result.payload !== undefined ? JSON.stringify(result.payload) : null,
        error: result.error ? { message: result.error } : null,
      },
    };
    if (ws.readyState === WebSocket.OPEN) {
      log(`[nodeConn] sending invoke result: id=${requestId} ok=${result.ok}${result.error ? ` error=${result.error}` : ""}`);
      ws.send(JSON.stringify(response));
    } else {
      log(`[nodeConn] ws not open, cannot send invoke result for ${requestId}`);
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { this.stopHeartbeat(); return; }
      ws.ping();
      this.heartbeatTimeout = setTimeout(() => {
        this.stopHeartbeat();
        ws.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
    ws.on("pong", () => {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
  }
}
