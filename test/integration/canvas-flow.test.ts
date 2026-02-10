/**
 * Integration test: Canvas / A2UI flow
 *
 * Simulates the A2UI event lifecycle:
 *   server sends a2ui events → router dispatches to canvas target
 *   → verify surface creation, component updates, data model updates
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
  A2UIMessage,
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

/** Collects A2UI messages for assertion. */
class CanvasCollector implements CanvasTarget {
  messages: A2UIMessage[] = [];
  postA2UIMessage(message: A2UIMessage): void {
    this.messages.push(message);
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

  it("should route createSurface a2ui event to canvas", async () => {
    const ws = await connectAndGetWs();

    const a2uiPayload: A2UIMessage = {
      type: "createSurface",
      surfaceId: "surface-001",
      title: "Code Review",
      layout: { type: "stack", direction: "vertical" },
    };

    ws.simulateMessage(
      makeEvent(
        { kind: "a2ui", payload: a2uiPayload },
        1
      )
    );

    expect(canvasCollector.messages).toHaveLength(1);
    expect(canvasCollector.messages[0]).toEqual(a2uiPayload);
    expect(canvasCollector.messages[0].type).toBe("createSurface");
    expect(canvasCollector.messages[0].surfaceId).toBe("surface-001");

    // Verify chat did NOT receive the a2ui event
    expect(chatTarget.postEvent).not.toHaveBeenCalled();
  });

  it("should route updateComponents a2ui event to canvas", async () => {
    const ws = await connectAndGetWs();

    const a2uiPayload: A2UIMessage = {
      type: "updateComponents",
      surfaceId: "surface-001",
      components: [
        { id: "c1", type: "text-block", props: { text: "Hello" } },
        { id: "c2", type: "button", props: { label: "Click me" } },
      ],
    };

    ws.simulateMessage(
      makeEvent(
        { kind: "a2ui", payload: a2uiPayload },
        1
      )
    );

    expect(canvasCollector.messages).toHaveLength(1);
    expect(canvasCollector.messages[0].type).toBe("updateComponents");
    const components = canvasCollector.messages[0].components as unknown[];
    expect(components).toHaveLength(2);
  });

  it("should route updateDataModel a2ui event to canvas", async () => {
    const ws = await connectAndGetWs();

    const a2uiPayload: A2UIMessage = {
      type: "updateDataModel",
      surfaceId: "surface-001",
      patch: {
        "/title": "Updated Title",
        "/status": "complete",
      },
    };

    ws.simulateMessage(
      makeEvent(
        { kind: "a2ui", payload: a2uiPayload },
        1
      )
    );

    expect(canvasCollector.messages).toHaveLength(1);
    expect(canvasCollector.messages[0].type).toBe("updateDataModel");
    const patch = canvasCollector.messages[0].patch as Record<string, unknown>;
    expect(patch["/title"]).toBe("Updated Title");
  });

  it("should handle a full surface lifecycle: create → components → data → more components", async () => {
    const ws = await connectAndGetWs();

    // Step 1: Create the surface
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "createSurface",
            surfaceId: "surface-dashboard",
            title: "Dashboard",
          },
        },
        1
      )
    );

    // Step 2: Add initial components
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "updateComponents",
            surfaceId: "surface-dashboard",
            components: [
              { id: "header", type: "text-block", props: { text: "Loading..." } },
            ],
          },
        },
        2
      )
    );

    // Step 3: Update data model
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "updateDataModel",
            surfaceId: "surface-dashboard",
            patch: {
              "/metrics/cpu": 45,
              "/metrics/memory": 72,
            },
          },
        },
        3
      )
    );

    // Step 4: Update components to reflect data
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "updateComponents",
            surfaceId: "surface-dashboard",
            components: [
              { id: "header", type: "text-block", props: { text: "Dashboard Ready" } },
              { id: "cpu-gauge", type: "gauge", props: { bind: "/metrics/cpu" } },
              { id: "mem-gauge", type: "gauge", props: { bind: "/metrics/memory" } },
            ],
          },
        },
        4
      )
    );

    // Verify all 4 A2UI messages arrived at canvas in order
    expect(canvasCollector.messages).toHaveLength(4);
    expect(canvasCollector.messages.map((m) => m.type)).toEqual([
      "createSurface",
      "updateComponents",
      "updateDataModel",
      "updateComponents",
    ]);
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
          payload: { type: "createSurface", surfaceId: "s1" },
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

    // Canvas got exactly 1 a2ui message
    expect(canvasCollector.messages).toHaveLength(1);
    expect(canvasCollector.messages[0].type).toBe("createSurface");

    // Chat got text_delta + text_delta + done = 3
    expect(chatTarget.postEvent).toHaveBeenCalledTimes(3);
  });

  it("should not send a2ui events to bridge", async () => {
    const ws = await connectAndGetWs();

    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: { type: "createSurface", surfaceId: "s1" },
        },
        1
      )
    );

    expect(bridgeTarget.showDiff).not.toHaveBeenCalled();
  });

  it("should handle sequence ordering for a2ui events", async () => {
    const ws = await connectAndGetWs();

    // Send events out of order
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: { type: "createSurface", surfaceId: "s1" },
        },
        2
      )
    );

    // This has a lower seq than the previous event, should be dropped
    ws.simulateMessage(
      makeEvent(
        {
          kind: "a2ui",
          payload: {
            type: "updateComponents",
            surfaceId: "s1",
            components: [],
          },
        },
        1
      )
    );

    // Only the first event should have made it through
    expect(canvasCollector.messages).toHaveLength(1);
    expect(canvasCollector.messages[0].type).toBe("createSurface");
  });
});
