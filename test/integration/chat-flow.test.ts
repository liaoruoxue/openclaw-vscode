/**
 * Integration test: Chat flow
 *
 * Simulates the full chat lifecycle:
 *   user sends message → GatewayClient sends command → server streams events
 *   → MessageRouter dispatches to chat → verify accumulated state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockWebSocket, MockWebSocketFactory } from "../helpers/mock-ws";
import {
  MessageRouter,
  type ChatTarget,
  type CanvasTarget,
  type BridgeTarget,
} from "../../src/gateway/router";
import type {
  GatewayEvent,
  AgentEventPayload,
  TextDeltaEvent,
  ToolStartEvent,
  ToolResultEvent,
  DoneEvent,
} from "../../src/gateway/types";

// Mock ws module
const wsFactory = new MockWebSocketFactory();
vi.mock("ws", () => ({
  default: class MockWS {
    constructor(url: string) {
      return wsFactory.create(url) as unknown as MockWS;
    }
    static OPEN = 1;
    static CLOSED = 3;
  },
  __esModule: true,
}));

const { GatewayClient } = await import("../../src/gateway/client");

/** Collects events routed to chat for assertion. */
class ChatCollector implements ChatTarget {
  events: AgentEventPayload[] = [];
  postEvent(event: AgentEventPayload): void {
    this.events.push(event);
  }
}

describe("Integration: Chat Flow", () => {
  let client: InstanceType<typeof GatewayClient>;
  let chatCollector: ChatCollector;
  let canvasTarget: CanvasTarget;
  let bridgeTarget: BridgeTarget;
  let router: MessageRouter;

  beforeEach(() => {
    wsFactory.reset();
    vi.useFakeTimers();

    client = new GatewayClient();
    chatCollector = new ChatCollector();
    canvasTarget = { postA2UIMessage: vi.fn() };
    bridgeTarget = { showDiff: vi.fn() };
    router = new MessageRouter(chatCollector, canvasTarget, bridgeTarget);

    // Wire up: client events → router
    client.onEvent((event) => router.route(event));
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  async function connectClient(): Promise<MockWebSocket> {
    const connectPromise = client.connect("ws://localhost:8080");
    const ws = wsFactory.latest!;

    // Simulate full Gateway handshake
    ws.simulateOpen();
    ws.simulateMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "test-nonce", ts: Date.now() },
    });
    ws.simulateMessage({
      type: "res",
      id: "connect",
      ok: true,
      payload: { type: "hello-ok", protocol: 3 },
    });

    await connectPromise;
    return ws;
  }

  function makeEvent(payload: AgentEventPayload, seq: number): GatewayEvent {
    return { type: "event", event: "agent", payload, seq };
  }

  it("should handle a complete send → stream → done cycle", async () => {
    const ws = await connectClient();

    // 1. User sends a chat message
    const sendPromise = client.chatSend("session-1", "Explain async/await");
    const cmd = ws.sentMessages[1] as Record<string, unknown>;

    // Server acknowledges with runId
    ws.simulateMessage({
      type: "res",
      id: cmd.id,
      ok: true,
      payload: { runId: "run-001" },
    });
    const result = await sendPromise;
    expect(result.runId).toBe("run-001");

    // 2. Server streams events
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: "Async/await " } as TextDeltaEvent, 1)
    );
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: "is a way " } as TextDeltaEvent, 2)
    );
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: "to handle promises." } as TextDeltaEvent, 3)
    );

    // 3. Server signals done
    ws.simulateMessage(
      makeEvent({ kind: "done", stopReason: "end_turn" } as DoneEvent, 4)
    );

    // 4. Verify collected chat events
    expect(chatCollector.events).toHaveLength(4);
    expect(chatCollector.events[0]).toEqual({
      kind: "text_delta",
      content: "Async/await ",
    });
    expect(chatCollector.events[1]).toEqual({
      kind: "text_delta",
      content: "is a way ",
    });
    expect(chatCollector.events[2]).toEqual({
      kind: "text_delta",
      content: "to handle promises.",
    });
    expect(chatCollector.events[3]).toEqual({
      kind: "done",
      stopReason: "end_turn",
    });

    // Full streamed text
    const fullText = chatCollector.events
      .filter((e): e is TextDeltaEvent => e.kind === "text_delta")
      .map((e) => e.content)
      .join("");
    expect(fullText).toBe("Async/await is a way to handle promises.");
  });

  it("should handle tool use within a chat response", async () => {
    const ws = await connectClient();

    // Start a chat
    const sendPromise = client.chatSend("session-1", "Read my package.json");
    const cmd = ws.sentMessages[1] as Record<string, unknown>;
    ws.simulateMessage({
      type: "res",
      id: cmd.id,
      ok: true,
      payload: { runId: "run-002" },
    });
    await sendPromise;

    // Stream: text → tool_start → tool_result → more text → done
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: "Let me read that file." } as TextDeltaEvent, 1)
    );
    ws.simulateMessage(
      makeEvent(
        {
          kind: "tool_start",
          tool: "read_file",
          id: "tool-1",
          title: "Reading package.json",
        } as ToolStartEvent,
        2
      )
    );
    ws.simulateMessage(
      makeEvent(
        {
          kind: "tool_result",
          id: "tool-1",
          output: '{ "name": "my-app" }',
        } as ToolResultEvent,
        3
      )
    );
    ws.simulateMessage(
      makeEvent(
        { kind: "text_delta", content: "Your package name is my-app." } as TextDeltaEvent,
        4
      )
    );
    ws.simulateMessage(
      makeEvent({ kind: "done", stopReason: "end_turn" } as DoneEvent, 5)
    );

    // Verify all events arrived at chat in order
    expect(chatCollector.events).toHaveLength(5);
    expect(chatCollector.events.map((e) => e.kind)).toEqual([
      "text_delta",
      "tool_start",
      "tool_result",
      "text_delta",
      "done",
    ]);
  });

  it("should handle abort during streaming", async () => {
    const ws = await connectClient();

    // Start chat
    const sendPromise = client.chatSend("session-1", "Write a long essay");
    const sendCmd = ws.sentMessages[1] as Record<string, unknown>;
    ws.simulateMessage({
      type: "res",
      id: sendCmd.id,
      ok: true,
      payload: { runId: "run-003" },
    });
    await sendPromise;

    // Some streaming
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: "Chapter 1..." } as TextDeltaEvent, 1)
    );

    // User aborts
    const abortPromise = client.chatAbort("session-1", "run-003");
    const abortCmd = ws.sentMessages[2] as Record<string, unknown>;
    expect(abortCmd.method).toBe("chat.abort");

    ws.simulateMessage({ type: "res", id: abortCmd.id, ok: true, payload: {} });
    await abortPromise;

    // Server sends done with abort reason
    ws.simulateMessage(
      makeEvent({ kind: "done", stopReason: "aborted" } as DoneEvent, 2)
    );

    expect(chatCollector.events).toHaveLength(2);
    expect(chatCollector.events[1]).toEqual({
      kind: "done",
      stopReason: "aborted",
    });
  });

  it("should handle interleaved chat and diff events", async () => {
    const ws = await connectClient();

    const sendPromise = client.chatSend("session-1", "Fix the bug in main.ts");
    const cmd = ws.sentMessages[1] as Record<string, unknown>;
    ws.simulateMessage({
      type: "res",
      id: cmd.id,
      ok: true,
      payload: { runId: "run-004" },
    });
    await sendPromise;

    // Text + diff + text + done
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: "I'll fix that." } as TextDeltaEvent, 1)
    );
    ws.simulateMessage(
      makeEvent(
        {
          kind: "diff",
          path: "src/main.ts",
          original: "const x = bug;",
          modified: "const x = fixed;",
        },
        2
      )
    );
    ws.simulateMessage(
      makeEvent({ kind: "text_delta", content: " Done!" } as TextDeltaEvent, 3)
    );
    ws.simulateMessage(
      makeEvent({ kind: "done", stopReason: "end_turn" } as DoneEvent, 4)
    );

    // Chat gets text + diff + text + done = 4 events
    expect(chatCollector.events).toHaveLength(4);
    // Bridge gets the diff
    expect(bridgeTarget.showDiff).toHaveBeenCalledWith(
      "const x = bug;",
      "const x = fixed;",
      "src/main.ts"
    );
  });

  it("should load chat history on chatHistory call", async () => {
    const ws = await connectClient();

    // Request history
    const historyPromise = client.chatHistory("session-1");
    const cmd = ws.sentMessages[1] as Record<string, unknown>;
    expect(cmd.method).toBe("chat.history");
    expect((cmd.params as Record<string, unknown>).sessionKey).toBe("session-1");

    // Simulate server response with historical messages
    ws.simulateMessage({
      type: "res",
      id: cmd.id,
      ok: true,
      payload: {
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Hi! How can I help?" },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "t1", name: "read_file", input: { path: "main.ts" } },
            ],
          },
        ],
      },
    });

    const messages = await historyPromise;
    expect(messages).toHaveLength(3);
    expect((messages[0] as Record<string, unknown>).role).toBe("user");
    expect((messages[0] as Record<string, unknown>).content).toBe("Hello");
    expect((messages[1] as Record<string, unknown>).role).toBe("assistant");
  });
});
