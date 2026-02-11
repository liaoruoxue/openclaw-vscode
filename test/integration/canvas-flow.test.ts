/**
 * Integration test: Canvas / A2UI flow
 *
 * Simulates the A2UI event lifecycle:
 *   server sends a2ui events → router dispatches to canvas target
 *   → verify v0.8 messages arrive at canvas, chat/bridge are not affected
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockWebSocketFactory } from "../helpers/mock-ws";
import {
  MessageRouter,
  type ChatTarget,
  type CanvasTarget,
  type BridgeTarget,
} from "../../src/gateway/router";
import type {
  GatewayEvent,
  AgentEventPayload,
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

/** Collects v0.8 message batches for assertion. */
class CanvasCollector implements CanvasTarget {
  batches: Record<string, unknown>[][] = [];
  postV08Messages(messages: Record<string, unknown>[]): void {
    this.batches.push(messages);
  }
  /** Flatten all batches into a single array */
  get allMessages(): Record<string, unknown>[] {
    return this.batches.flat();
  }
}

describe("Integration: Canvas/A2UI Flow", () => {
  let client: InstanceType<typeof GatewayClient>;
  let chatTarget: ChatTarget;
  let canvasCollector: CanvasCollector;
  let bridgeTarget: BridgeTarget;
  let router: MessageRouter;

  beforeEach(() => {
    wsFactory.reset();
    vi.useFakeTimers();

    client = new GatewayClient();
    chatTarget = { postEvent: vi.fn() };
    canvasCollector = new CanvasCollector();
    bridgeTarget = { showDiff: vi.fn() };
    router = new MessageRouter(chatTarget, canvasCollector, bridgeTarget);

    client.onEvent((event) => router.route(event));
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  function makeEvent(payload: AgentEventPayload, seq: number): GatewayEvent {
    return { type: "event", event: "agent", payload, seq };
  }

  async function connectAndGetWs() {
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

  it("should route a2ui events with components to canvas as v0.8", async () => {
    const ws = await connectAndGetWs();

    // Send a createSurface with a component — should produce v0.8 surfaceUpdate + beginRendering
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "createSurface",
            surfaceId: "surface-001",
            content: { type: "text", text: "Hello" },
          },
        },
        1
      )
    );

    // Canvas should have received one batch with v0.8 messages
    expect(canvasCollector.batches).toHaveLength(1);
    const batch = canvasCollector.batches[0];
    expect(batch.length).toBeGreaterThanOrEqual(1);

    // Should contain surfaceUpdate and beginRendering
    const hasSurfaceUpdate = batch.some((m) => "surfaceUpdate" in m);
    const hasBeginRendering = batch.some((m) => "beginRendering" in m);
    expect(hasSurfaceUpdate).toBe(true);
    expect(hasBeginRendering).toBe(true);

    // Verify chat did NOT receive the a2ui event
    expect(chatTarget.postEvent).not.toHaveBeenCalled();
  });

  it("should route bare component a2ui events to canvas", async () => {
    const ws = await connectAndGetWs();

    // A bare component (e.g. table) — should be converted to v0.8
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "table",
            columns: ["Name", "Age"],
            rows: [["Alice", "30"]],
          },
        },
        1
      )
    );

    expect(canvasCollector.batches).toHaveLength(1);
    const batch = canvasCollector.batches[0];
    expect(batch.length).toBeGreaterThanOrEqual(1);
    expect(batch.some((m) => "surfaceUpdate" in m)).toBe(true);
  });

  it("should pass through already-v0.8 messages", async () => {
    const ws = await connectAndGetWs();

    const v08Msg = {
      surfaceUpdate: {
        surfaceId: "demo",
        components: [
          { id: "t1", component: { Text: { text: { literalString: "Hi" } } } },
        ],
      },
    };

    ws.simulateMessage(
      makeEvent(
        { kind: "a2ui", payload: v08Msg },
        1
      )
    );

    expect(canvasCollector.batches).toHaveLength(1);
    const batch = canvasCollector.batches[0];
    // v0.8 messages should pass through
    expect(batch.some((m) => "surfaceUpdate" in m)).toBe(true);
  });

  it("should handle a full surface lifecycle with multiple a2ui events", async () => {
    const ws = await connectAndGetWs();

    // Step 1: Surface with initial content
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "createSurface",
            surfaceId: "surface-dashboard",
            content: { type: "text", text: "Loading..." },
          },
        },
        1
      )
    );

    // Step 2: Another component update
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            surfaceUpdate: {
              surfaceId: "surface-dashboard",
              components: [
                { id: "header", component: { Text: { text: { literalString: "Dashboard Ready" } } } },
              ],
            },
          },
        },
        2
      )
    );

    // Step 3: Begin rendering
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            beginRendering: { surfaceId: "surface-dashboard", root: "header" },
          },
        },
        3
      )
    );

    // All 3 events should have been routed to canvas
    expect(canvasCollector.batches).toHaveLength(3);
  });

  it("should handle mixed a2ui and chat events correctly", async () => {
    const ws = await connectAndGetWs();

    // Text event → should go to chat
    ws.simulateMessage(
      makeEvent(
        { kind: "text_delta", content: "Creating a surface for you..." },
        1
      )
    );

    // A2UI event → should go to canvas
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            surfaceUpdate: {
              surfaceId: "s1",
              components: [
                { id: "t1", component: { Text: { text: { literalString: "Hi" } } } },
              ],
            },
          },
        },
        2
      )
    );

    // More text → chat
    ws.simulateMessage(
      makeEvent(
        { kind: "text_delta", content: " Surface is ready." },
        3
      )
    );

    // Done → chat
    ws.simulateMessage(
      makeEvent(
        { kind: "done", stopReason: "end_turn" },
        4
      )
    );

    // Canvas got exactly 1 batch
    expect(canvasCollector.batches).toHaveLength(1);

    // Chat got text_delta + text_delta + done = 3
    expect(chatTarget.postEvent).toHaveBeenCalledTimes(3);
  });

  it("should not send a2ui events to bridge", async () => {
    const ws = await connectAndGetWs();

    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            surfaceUpdate: {
              surfaceId: "s1",
              components: [
                { id: "t1", component: { Text: { text: { literalString: "Hi" } } } },
              ],
            },
          },
        },
        1
      )
    );

    expect(bridgeTarget.showDiff).not.toHaveBeenCalled();
  });

  it("should handle sequence ordering for a2ui events", async () => {
    const ws = await connectAndGetWs();

    // Send event with seq 2
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            surfaceUpdate: {
              surfaceId: "s1",
              components: [
                { id: "t1", component: { Text: { text: { literalString: "First" } } } },
              ],
            },
          },
        },
        2
      )
    );

    // This has a lower seq — should be dropped
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            surfaceUpdate: {
              surfaceId: "s1",
              components: [
                { id: "t2", component: { Text: { text: { literalString: "Late" } } } },
              ],
            },
          },
        },
        1
      )
    );

    // Only the first event should have made it through
    expect(canvasCollector.batches).toHaveLength(1);
  });
});
