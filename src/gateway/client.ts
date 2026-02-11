import WebSocket from "ws";
import * as crypto from "crypto";
import {
  ConnectionState,
  GatewayRequest,
  GatewayEvent,
  ChatOptions,
  Session,
} from "./types";

type EventHandler = (event: GatewayEvent) => void;
type StateHandler = (state: ConnectionState) => void;
type Disposable = { dispose(): void };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const COMMAND_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;
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

function formatError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    return JSON.stringify(err);
  }
  return String(err);
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private handlers: Set<EventHandler> = new Set();
  private stateHandlers: Set<StateHandler> = new Set();
  private _state: ConnectionState = "disconnected";
  private _sessionKey: string | null = null;
  private _canvasHostUrl: string | null = null;
  private _log: (msg: string) => void = () => {};

  private url: string | null = null;
  private token: string | undefined;
  private deviceKeys: { publicKey: string; privateKey: string } | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  private pendingRequests: Map<string, PendingRequest> = new Map();
  private commandIdCounter = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  get state(): ConnectionState {
    return this._state;
  }

  get sessionKey(): string | null {
    return this._sessionKey;
  }

  get canvasHostUrl(): string | null {
    return this._canvasHostUrl;
  }

  setLogger(fn: (msg: string) => void): void {
    this._log = fn;
  }

  async connect(url: string, token?: string, deviceKeys?: { publicKey: string; privateKey: string }): Promise<void> {
    this.url = url;
    this.token = token;
    this.deviceKeys = deviceKeys;
    this.intentionalDisconnect = false;
    this.reconnectAttempt = 0;
    return this.doConnect();
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.rejectAllPending("Client disconnected");
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.setState("disconnected");
  }

  onEvent(handler: EventHandler): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  onStateChange(handler: StateHandler): Disposable {
    this.stateHandlers.add(handler);
    return {
      dispose: () => {
        this.stateHandlers.delete(handler);
      },
    };
  }

  async chatSend(
    sessionKey: string,
    message: string,
    options?: ChatOptions
  ): Promise<{ runId: string }> {
    this._sessionKey = sessionKey;
    const result = await this.sendCommand("chat.send", {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
    });
    return result as { runId: string };
  }

  async chatAbort(sessionKey: string, runId: string): Promise<void> {
    await this.sendCommand("chat.abort", {
      sessionKey,
      runId,
    });
  }

  async chatHistory(sessionKey: string): Promise<unknown[]> {
    const result = await this.sendCommand("chat.history", {
      sessionKey,
    });
    return (result as { messages: unknown[] }).messages ?? [];
  }

  async sessionList(): Promise<Session[]> {
    const result = await this.sendCommand("session.list", {});
    return (result as { sessions: Session[] }).sessions ?? [];
  }

  async sessionCreate(key: string, agent?: string): Promise<Session> {
    const result = await this.sendCommand("session.create", {
      key,
      ...(agent ? { agent } : {}),
    });
    return result as Session;
  }

  async nodePairRequest(): Promise<unknown> {
    const deviceId = this.deviceKeys
      ? crypto.createHash("sha256")
          .update(Buffer.from(this.deviceKeys.publicKey, "hex"))
          .digest("hex")
      : crypto.randomUUID();
    return this.sendCommand("node.pair.request", {
      nodeId: deviceId,
      displayName: `VS Code (${process.platform})`,
      platform: process.platform,
      version: "0.1.0",
      caps: ["canvas"],
      commands: ["canvas.present"],
    });
  }

  protected emit(event: GatewayEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  // --- Private implementation ---

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  private nextCommandId(): string {
    return `cmd_${++this.commandIdCounter}`;
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.url) {
        reject(new Error("No URL configured"));
        return;
      }

      this.setState("connecting");

      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      const onOpen = () => {
        cleanup();
        this.reconnectAttempt = 0;
        this.setupMessageHandler(ws, (err) => {
          if (settled) return;
          settled = true;
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        // Wait for connect.challenge event before sending handshake
      };

      const onError = (err: Error) => {
        cleanup();
        this.ws = null;
        this.setState("error");
        if (!settled) {
          settled = true;
          if (this.reconnectAttempt === 0) {
            reject(err);
          }
        }
        this.scheduleReconnect();
      };

      const onClose = () => {
        cleanup();
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error("Connection closed before handshake completed"));
        }
        if (!this.intentionalDisconnect) {
          this.setState("disconnected");
          this.scheduleReconnect();
        }
      };

      const cleanup = () => {
        ws.removeListener("open", onOpen);
        ws.removeListener("error", onError);
        ws.removeListener("close", onClose);
      };

      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private sendHandshake(ws: WebSocket, nonce?: string): void {
    const clientId = "cli";
    const clientMode = "cli";
    const role = "operator";
    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];

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
      caps: [],
      commands: [],
      permissions: {},
    };

    if (this.token) {
      params.auth = { token: this.token };
    }

    if (this.deviceKeys) {
      const signedAtMs = Date.now();
      const deviceId = crypto.createHash("sha256")
        .update(Buffer.from(this.deviceKeys.publicKey, "hex"))
        .digest("hex");
      const payload = buildDeviceAuthPayload({
        deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: this.token,
        nonce,
      });
      const privateKeyObj = crypto.createPrivateKey({
        key: Buffer.from(this.deviceKeys.privateKey, "hex"),
        format: "der",
        type: "pkcs8",
      });
      const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyObj);
      params.device = {
        id: deviceId,
        publicKey: base64UrlEncode(Buffer.from(this.deviceKeys.publicKey, "hex")),
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

  private setupMessageHandler(
    ws: WebSocket,
    onHandshakeComplete: (err?: Error) => void
  ): void {
    let handshakeDone = false;

    const completeHandshake = () => {
      if (handshakeDone) return;
      clearTimeout(handshakeTimer);
      handshakeDone = true;
      this.setState("connected");
      this.startHeartbeat(ws);
      onHandshakeComplete();
    };

    // Handshake timeout — if Gateway doesn't respond within 10s, fail
    const handshakeTimer = setTimeout(() => {
      if (!handshakeDone) {
        handshakeDone = true;
        onHandshakeComplete(new Error("Handshake timed out waiting for connect.ok"));
        ws.close(1000, "Handshake timeout");
      }
    }, 10_000);

    ws.on("message", (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }

      // --- Handshake phase ---
      if (!handshakeDone) {
        // Gateway sends challenge event → we respond with connect req
        if (parsed.type === "event") {
          const eventName = parsed.event as string;
          if (eventName === "connect.challenge") {
            const payload = parsed.payload as Record<string, unknown> | undefined;
            const nonce = payload?.nonce as string | undefined;
            this.sendHandshake(ws, nonce);
            return;
          }
        }

        // Gateway responds to our connect req with res frame
        if (parsed.type === "res" && parsed.id === "connect") {
          if (parsed.ok === true) {
            // Extract canvasHostUrl from hello-ok payload
            const payload = parsed.payload as Record<string, unknown> | undefined;
            if (typeof payload?.canvasHostUrl === "string") {
              this._canvasHostUrl = payload.canvasHostUrl;
            }
            completeHandshake();
          } else {
            handshakeDone = true;
            clearTimeout(handshakeTimer);
            onHandshakeComplete(new Error(formatError(parsed.error ?? "Handshake rejected")));
          }
          return;
        }
      }

      // --- Normal message handling (post-handshake) ---
      if (parsed.type === "event") {
        const eventName = parsed.event as string;
        const seq = parsed.seq as number | undefined;

        if (eventName === "agent") {
          const p = parsed.payload as Record<string, unknown> | undefined;
          if (p?.stream === "assistant") {
            // Raw agent stream events carry per-token deltas — use these for text.
            const data = p.data as Record<string, unknown> | undefined;
            const delta = data?.delta as string | undefined;
            if (delta) {
              this.emit({
                type: "event", event: "agent", seq,
                payload: { kind: "text_delta", content: delta },
              } as GatewayEvent);
            }
          } else if (p?.kind != null) {
            // Already-translated agent events (tool_start, tool_result, diff, done, etc.)
            this._log(`[gateway] Agent event: kind=${p.kind} seq=${seq}`);
            this.emit(parsed as unknown as GatewayEvent);
          } else {
            // Log dropped agent events for debugging
            const keys = p ? Object.keys(p).join(",") : "(null)";
            this._log(`[gateway] Dropped agent event: keys=[${keys}] seq=${seq}`);
          }

        } else if (eventName === "chat") {
          // Chat events are batched — only use for final/error/aborted status.
          const p = parsed.payload as Record<string, unknown>;
          const state = p.state as string;

          if (state === "final") {
            this.emit({
              type: "event", event: "agent", seq,
              payload: { kind: "done", stopReason: "end_turn" },
            } as GatewayEvent);
          } else if (state === "error") {
            this.emit({
              type: "event", event: "agent", seq,
              payload: { kind: "done", stopReason: (p.errorMessage as string) ?? "error" },
            } as GatewayEvent);
          } else if (state === "aborted") {
            this.emit({
              type: "event", event: "agent", seq,
              payload: { kind: "done", stopReason: "aborted" },
            } as GatewayEvent);
          }
          // Skip chat delta — agent stream events provide per-token text

        } else if (eventName !== "health" && eventName !== "tick") {
          this.emit(parsed as unknown as GatewayEvent);
        }
      } else if (parsed.type === "res" && typeof parsed.id === "string") {
        const pending = this.pendingRequests.get(parsed.id);
        if (pending) {
          this.pendingRequests.delete(parsed.id);
          clearTimeout(pending.timer);
          if (parsed.ok === false) {
            pending.reject(new Error(formatError(parsed.error)));
          } else {
            pending.resolve(parsed.payload ?? parsed);
          }
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      this.ws = null;
      this.stopHeartbeat();
      this.rejectAllPending("Connection closed");
      if (!handshakeDone) {
        handshakeDone = true;
        onHandshakeComplete(new Error("Connection closed during handshake"));
      }
      if (!this.intentionalDisconnect) {
        this.setState("disconnected");
        this.scheduleReconnect();
      }
    });

    ws.on("error", () => {
      this.setState("error");
    });
  }

  private sendCommand(
    command: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to Gateway"));
        return;
      }

      const id = this.nextCommandId();
      const frame: GatewayRequest = {
        type: "req",
        id,
        method: command,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command '${command}' timed out`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame));
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.setState("error");
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalDisconnect) {
        this.doConnect().catch(() => {
          // reconnect failure handled by scheduleReconnect inside doConnect
        });
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      ws.ping();
      this.heartbeatTimeout = setTimeout(() => {
        // No pong received — assume dead connection
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
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
