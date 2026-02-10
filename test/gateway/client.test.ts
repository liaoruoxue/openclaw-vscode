import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockWebSocket, MockWebSocketFactory } from "../helpers/mock-ws";
import type { GatewayEvent } from "../../src/gateway/types";

// Mock the ws module before importing GatewayClient
const wsFactory = new MockWebSocketFactory();
vi.mock("ws", () => ({
  default: class MockWS {
    constructor(url: string) {
      const mock = wsFactory.create(url);
      return mock as unknown as MockWS;
    }
    static OPEN = 1;
    static CLOSED = 3;
  },
  __esModule: true,
}));

// Now import the client — it will use our mocked WebSocket
const { GatewayClient } = await import("../../src/gateway/client");

describe("GatewayClient", () => {
  let client: InstanceType<typeof GatewayClient>;

  beforeEach(() => {
    wsFactory.reset();
    client = new GatewayClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  /** Simulate full Gateway handshake: open → challenge → connect res */
  function simulateHandshake(ws: MockWebSocket): void {
    ws.simulateOpen();
    // Gateway sends challenge — client responds with connect req
    ws.simulateMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "test-nonce-123", ts: Date.now() },
    });
    // Gateway confirms connection with res frame
    ws.simulateMessage({
      type: "res",
      id: "connect",
      ok: true,
      payload: { type: "hello-ok", protocol: 3 },
    });
  }

  describe("connect", () => {
    it("should transition to connecting then connected on successful handshake", async () => {
      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      expect(client.state).toBe("connecting");
      simulateHandshake(ws);

      await connectPromise;
      expect(client.state).toBe("connected");
      expect(states).toEqual(["connecting", "connected"]);
    });

    it("should send handshake with correct format after challenge", async () => {
      const connectPromise = client.connect("ws://localhost:8080", "my-token");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      // Only 1 message: the connect req sent after challenge
      expect(ws.sentMessages.length).toBe(1);
      const handshake = ws.sentMessages[0] as Record<string, unknown>;
      expect(handshake.type).toBe("req");
      expect(handshake.id).toBe("connect");
      expect(handshake.method).toBe("connect");
      const params = handshake.params as Record<string, unknown>;
      expect(params.minProtocol).toBe(3);
      expect(params.maxProtocol).toBe(3);
      expect(params.client).toEqual(
        expect.objectContaining({ id: "cli", version: "0.1.0" })
      );
      expect(params.auth).toEqual({ token: "my-token" });
    });

    it("should not include auth when no token provided", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const handshake = ws.sentMessages[0] as Record<string, unknown>;
      const params = handshake.params as Record<string, unknown>;
      expect(params.auth).toBeUndefined();
    });

    it("should reject on connection error", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      ws.simulateError(new Error("Connection refused"));

      await expect(connectPromise).rejects.toThrow();
      expect(client.state).toBe("error");
    });
  });

  describe("disconnect", () => {
    it("should close the WebSocket and set state to disconnected", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      client.disconnect();

      expect(client.state).toBe("disconnected");
    });

    it("should reject pending commands on disconnect", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const chatPromise = client.chatSend("session-1", "hello");
      client.disconnect();

      await expect(chatPromise).rejects.toThrow("Client disconnected");
    });
  });

  describe("onEvent", () => {
    it("should dispatch events to registered handlers", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      const testEvent: GatewayEvent = {
        type: "event",
        event: "agent",
        payload: { kind: "text_delta", content: "Hello" },
        seq: 1,
      };
      ws.simulateMessage(testEvent);

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({
        kind: "text_delta",
        content: "Hello",
      });
    });

    it("should support unsubscribing via dispose", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      const sub = client.onEvent((event) => received.push(event));

      ws.simulateMessage({
        type: "event",
        event: "agent",
        payload: { kind: "text_delta", content: "1" },
      });
      sub.dispose();
      ws.simulateMessage({
        type: "event",
        event: "agent",
        payload: { kind: "text_delta", content: "2" },
      });

      expect(received).toHaveLength(1);
    });

    it("should ignore non-JSON messages", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      ws.simulateMessage("not valid json {{{");
      expect(received).toHaveLength(0);
    });
  });

  describe("chatSend", () => {
    it("should send a chat.send command with correct format", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      // Don't await the promise — we need to respond to it
      const sendPromise = client.chatSend("session-1", "Hello world");

      // Verify the sent command (index 0 = handshake, 1 = first command)
      const cmd = ws.sentMessages[1] as Record<string, unknown>;
      expect(cmd.type).toBe("req");
      expect(cmd.method).toBe("chat.send");
      const params = cmd.params as Record<string, unknown>;
      expect(params.sessionKey).toBe("session-1");
      expect(params.message).toBe("Hello world");
      expect(params.idempotencyKey).toBeDefined();
      expect(cmd.id).toBeDefined();

      // Simulate response from server
      ws.simulateMessage({
        type: "res",
        id: cmd.id,
        ok: true,
        payload: { runId: "run-123" },
      });

      const result = await sendPromise;
      expect(result).toEqual({ runId: "run-123" });
    });

    it("should set the sessionKey", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      simulateHandshake(ws);
      await connectPromise;

      expect(client.sessionKey).toBeNull();

      const sendPromise = client.chatSend("session-42", "hi");
      expect(client.sessionKey).toBe("session-42");

      // Resolve the promise
      const cmd = ws.sentMessages[1] as Record<string, unknown>;
      ws.simulateMessage({
        type: "res",
        id: cmd.id,
        ok: true,
        payload: { runId: "run-1" },
      });
      await sendPromise;
    });

    it("should reject if not connected", async () => {
      await expect(
        client.chatSend("session-1", "hello")
      ).rejects.toThrow("Not connected");
    });

  });

  describe("chatAbort", () => {
    it("should send a chat.abort command", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      simulateHandshake(ws);
      await connectPromise;

      const abortPromise = client.chatAbort("session-1", "run-123");

      const cmd = ws.sentMessages[1] as Record<string, unknown>;
      expect(cmd.method).toBe("chat.abort");
      expect(cmd.params).toEqual({
        sessionKey: "session-1",
        runId: "run-123",
      });

      ws.simulateMessage({ type: "res", id: cmd.id, ok: true, payload: {} });
      await abortPromise;
    });
  });

  describe("command response handling", () => {
    it("should reject on error response", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      simulateHandshake(ws);
      await connectPromise;

      const sendPromise = client.chatSend("s1", "hi");
      const cmd = ws.sentMessages[1] as Record<string, unknown>;

      ws.simulateMessage({
        type: "res",
        id: cmd.id,
        ok: false,
        error: "Session not found",
      });

      await expect(sendPromise).rejects.toThrow("Session not found");
    });

    it("should timeout if no response received", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      simulateHandshake(ws);
      await connectPromise;

      const sendPromise = client.chatSend("s1", "hi");

      // Advance time past the 30s timeout
      vi.advanceTimersByTime(31_000);

      await expect(sendPromise).rejects.toThrow("timed out");
    });
  });

  describe("reconnection", () => {
    it("should attempt reconnect after unexpected disconnect", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const statesBefore = wsFactory.instances.length;

      // Simulate unexpected close from the server side (via the close handler on ws)
      ws.simulateClose(1006, "Abnormal closure");

      // Advance past the first reconnect delay (1s)
      vi.advanceTimersByTime(1_100);

      // A new WebSocket instance should have been created
      expect(wsFactory.instances.length).toBeGreaterThan(statesBefore);
    });

    it("should not reconnect after intentional disconnect", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const countBefore = wsFactory.instances.length;
      client.disconnect();

      vi.advanceTimersByTime(60_000);
      expect(wsFactory.instances.length).toBe(countBefore);
    });
  });

  describe("onStateChange", () => {
    it("should notify state change handlers", async () => {
      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      expect(states).toContain("connecting");
      expect(states).toContain("connected");
    });

    it("should support dispose", async () => {
      const states: string[] = [];
      const sub = client.onStateChange((s) => states.push(s));
      sub.dispose();

      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      expect(states).toHaveLength(0);
    });
  });

  describe("sessionList", () => {
    it("should send session.list command and return sessions", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      simulateHandshake(ws);
      await connectPromise;

      const listPromise = client.sessionList();
      const cmd = ws.sentMessages[1] as Record<string, unknown>;
      expect(cmd.method).toBe("session.list");

      ws.simulateMessage({
        type: "res",
        id: cmd.id,
        ok: true,
        payload: {
          sessions: [{ key: "s1", agent: "main" }],
        },
      });

      const sessions = await listPromise;
      expect(sessions).toEqual([{ key: "s1", agent: "main" }]);
    });
  });

  describe("chat event translation", () => {
    it("should translate raw agent stream events into agent text_delta", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      // Gateway sends raw agent event with stream=assistant and data.delta
      ws.simulateMessage({
        type: "event",
        event: "agent",
        seq: 1,
        payload: {
          stream: "assistant",
          data: { delta: "Hello", text: "Hello" },
        },
      });

      ws.simulateMessage({
        type: "event",
        event: "agent",
        seq: 2,
        payload: {
          stream: "assistant",
          data: { delta: " world", text: "Hello world" },
        },
      });

      expect(received).toHaveLength(2);
      expect(received[0].event).toBe("agent");
      expect(received[0].payload).toEqual({
        kind: "text_delta",
        content: "Hello",
      });
      expect(received[1].payload).toEqual({
        kind: "text_delta",
        content: " world",
      });
    });

    it("should translate Gateway chat final events into agent done", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      ws.simulateMessage({
        type: "event",
        event: "chat",
        payload: {
          state: "final",
          seq: 5,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe("agent");
      expect(received[0].payload).toEqual({
        kind: "done",
        stopReason: "end_turn",
      });
    });

    it("should translate Gateway chat error events into agent done with error", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      ws.simulateMessage({
        type: "event",
        event: "chat",
        payload: {
          state: "error",
          errorMessage: "rate limit exceeded",
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({
        kind: "done",
        stopReason: "rate limit exceeded",
      });
    });

    it("should filter out health events", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      ws.simulateMessage({
        type: "event",
        event: "health",
        payload: { status: "ok" },
      });

      expect(received).toHaveLength(0);
    });

    it("should skip chat delta events (batched, use agent stream instead)", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      ws.simulateMessage({
        type: "event",
        event: "chat",
        payload: {
          state: "delta",
          seq: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
        },
      });

      expect(received).toHaveLength(0);
    });

    it("should ignore agent lifecycle events without stream=assistant", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const received: GatewayEvent[] = [];
      client.onEvent((event) => received.push(event));

      // Agent event without stream field (lifecycle event)
      ws.simulateMessage({
        type: "event",
        event: "agent",
        seq: 1,
        payload: { status: "started" },
      });

      expect(received).toHaveLength(0);
    });
  });

  describe("sessionCreate", () => {
    it("should send session.create with key and agent", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      simulateHandshake(ws);
      await connectPromise;

      const createPromise = client.sessionCreate("new-session", "coder");
      const cmd = ws.sentMessages[1] as Record<string, unknown>;
      expect(cmd.method).toBe("session.create");
      expect(cmd.params).toEqual({ key: "new-session", agent: "coder" });

      ws.simulateMessage({
        type: "res",
        id: cmd.id,
        ok: true,
        payload: { key: "new-session", agent: "coder" },
      });

      const session = await createPromise;
      expect(session).toEqual({ key: "new-session", agent: "coder" });
    });
  });

  describe("heartbeat", () => {
    it("should send ping after heartbeat interval", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      let pingSent = false;
      ws.on("ping_sent", () => { pingSent = true; });

      simulateHandshake(ws);
      await connectPromise;

      expect(pingSent).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(pingSent).toBe(true);
    });

    it("should not terminate if pong received in time", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      // Trigger ping
      vi.advanceTimersByTime(30_000);
      // Simulate pong before timeout
      ws.simulatePong();
      // Advance past the pong timeout window — should NOT terminate
      vi.advanceTimersByTime(10_000);

      expect(ws.readyState).toBe(1); // OPEN
    });

    it("should terminate connection if no pong received", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;
      simulateHandshake(ws);
      await connectPromise;

      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      // Trigger ping
      vi.advanceTimersByTime(30_000);
      // Do NOT send pong — advance past timeout
      vi.advanceTimersByTime(10_100);

      expect(ws.readyState).toBe(3); // CLOSED (terminated)
    });

    it("should stop heartbeat on disconnect", async () => {
      const connectPromise = client.connect("ws://localhost:8080");
      const ws = wsFactory.latest!;

      let pingCount = 0;
      ws.on("ping_sent", () => { pingCount++; });

      simulateHandshake(ws);
      await connectPromise;

      client.disconnect();

      vi.advanceTimersByTime(60_000);
      expect(pingCount).toBe(0);
    });
  });
});
