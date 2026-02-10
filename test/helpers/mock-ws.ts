import { EventEmitter } from "events";

/**
 * Mock WebSocket that simulates the ws library's WebSocket class.
 * Uses EventEmitter internally for event dispatch.
 */
export class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];

  private _closeCode?: number;
  private _closeReason?: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  /** Simulate the server accepting the connection */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  /** Simulate receiving a message from the server */
  simulateMessage(data: string | object): void {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    this.emit("message", raw);
  }

  /** Simulate a server-initiated close */
  simulateClose(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", code, reason);
  }

  /** Simulate a connection error */
  simulateError(error: Error): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("error", error);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this._closeCode = code;
    this._closeReason = reason;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  /** Get parsed sent messages */
  get sentMessages(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  /** Get the last sent message parsed */
  get lastSentMessage(): unknown {
    if (this.sent.length === 0) return undefined;
    return JSON.parse(this.sent[this.sent.length - 1]);
  }

  get closeCode(): number | undefined {
    return this._closeCode;
  }

  get closeReason(): string | undefined {
    return this._closeReason;
  }
}

/**
 * Factory that captures MockWebSocket instances as they're created.
 * Use with vi.mock("ws") to intercept WebSocket construction.
 */
export class MockWebSocketFactory {
  instances: MockWebSocket[] = [];

  create = (url: string): MockWebSocket => {
    const ws = new MockWebSocket(url);
    this.instances.push(ws);
    return ws;
  };

  get latest(): MockWebSocket | undefined {
    return this.instances[this.instances.length - 1];
  }

  reset(): void {
    this.instances = [];
  }
}
