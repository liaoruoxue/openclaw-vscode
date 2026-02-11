import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MessageRouter,
  type ChatTarget,
  type CanvasTarget,
  type BridgeTarget,
} from "../../src/gateway/router";
import type {
  GatewayEvent,
  TextDeltaEvent,
  ToolStartEvent,
  ToolResultEvent,
  A2UIEvent,
  DiffEvent,
  DoneEvent,
} from "../../src/gateway/types";

function makeEvent(
  payload: GatewayEvent["payload"],
  seq?: number
): GatewayEvent {
  return {
    type: "event",
    event: "agent",
    payload,
    ...(seq !== undefined ? { seq } : {}),
  };
}

describe("MessageRouter", () => {
  let chat: ChatTarget;
  let canvas: CanvasTarget;
  let bridge: BridgeTarget;
  let router: MessageRouter;

  beforeEach(() => {
    chat = { postEvent: vi.fn() };
    canvas = { postV08Messages: vi.fn() };
    bridge = { showDiff: vi.fn() };
    router = new MessageRouter(chat, canvas, bridge);
  });

  describe("text_delta routing", () => {
    it("should route text_delta events to chat", () => {
      const payload: TextDeltaEvent = {
        kind: "text_delta",
        content: "Hello world",
      };
      router.route(makeEvent(payload));

      expect(chat.postEvent).toHaveBeenCalledWith(payload);
      expect(canvas.postV08Messages).not.toHaveBeenCalled();
      expect(bridge.showDiff).not.toHaveBeenCalled();
    });
  });

  describe("tool_start routing", () => {
    it("should route tool_start events to chat", () => {
      const payload: ToolStartEvent = {
        kind: "tool_start",
        tool: "read_file",
        id: "tool-1",
        title: "Reading file",
      };
      router.route(makeEvent(payload));

      expect(chat.postEvent).toHaveBeenCalledWith(payload);
      expect(canvas.postV08Messages).not.toHaveBeenCalled();
    });
  });

  describe("tool_result routing", () => {
    it("should route tool_result events to chat", () => {
      const payload: ToolResultEvent = {
        kind: "tool_result",
        id: "tool-1",
        output: "file contents here",
      };
      router.route(makeEvent(payload));

      expect(chat.postEvent).toHaveBeenCalledWith(payload);
      expect(canvas.postV08Messages).not.toHaveBeenCalled();
    });
  });

  describe("done routing", () => {
    it("should route done events to chat", () => {
      const payload: DoneEvent = {
        kind: "done",
        stopReason: "end_turn",
      };
      router.route(makeEvent(payload));

      expect(chat.postEvent).toHaveBeenCalledWith(payload);
    });
  });

  describe("a2ui routing", () => {
    it("should route a2ui events to canvas only", () => {
      const a2uiMsg = { type: "createSurface" as const, surfaceId: "s1" };
      const payload: A2UIEvent = {
        kind: "a2ui",
        payload: a2uiMsg,
      };
      router.route(makeEvent(payload));

      // Canvas should receive v0.8-converted messages
      expect(canvas.postV08Messages).toHaveBeenCalledTimes(1);
      expect(chat.postEvent).not.toHaveBeenCalled();
      expect(bridge.showDiff).not.toHaveBeenCalled();
    });
  });

  describe("diff routing", () => {
    it("should route diff events to both chat and bridge", () => {
      const payload: DiffEvent = {
        kind: "diff",
        path: "src/main.ts",
        original: "const x = 1;",
        modified: "const x = 2;",
      };
      router.route(makeEvent(payload));

      expect(chat.postEvent).toHaveBeenCalledWith(payload);
      expect(bridge.showDiff).toHaveBeenCalledWith(
        "const x = 1;",
        "const x = 2;",
        "src/main.ts"
      );
    });

    it("should pass empty string when original is null", () => {
      const payload: DiffEvent = {
        kind: "diff",
        path: "new-file.ts",
        original: null,
        modified: "console.log('new');",
      };
      router.route(makeEvent(payload));

      expect(bridge.showDiff).toHaveBeenCalledWith(
        "",
        "console.log('new');",
        "new-file.ts"
      );
    });
  });

  describe("sequence tracking", () => {
    it("should drop events with duplicate sequence numbers", () => {
      const payload1: TextDeltaEvent = {
        kind: "text_delta",
        content: "first",
      };
      const payload2: TextDeltaEvent = {
        kind: "text_delta",
        content: "duplicate",
      };

      router.route(makeEvent(payload1, 1));
      router.route(makeEvent(payload2, 1)); // same seq, should be dropped

      expect(chat.postEvent).toHaveBeenCalledTimes(1);
      expect(chat.postEvent).toHaveBeenCalledWith(payload1);
    });

    it("should drop events with lower sequence numbers (out of order)", () => {
      const payload1: TextDeltaEvent = {
        kind: "text_delta",
        content: "second",
      };
      const payload2: TextDeltaEvent = {
        kind: "text_delta",
        content: "first-but-late",
      };

      router.route(makeEvent(payload1, 5));
      router.route(makeEvent(payload2, 3)); // out of order, should be dropped

      expect(chat.postEvent).toHaveBeenCalledTimes(1);
    });

    it("should accept events without sequence numbers", () => {
      const payload: TextDeltaEvent = {
        kind: "text_delta",
        content: "no seq",
      };
      router.route(makeEvent(payload)); // no seq
      router.route(makeEvent(payload)); // no seq again

      expect(chat.postEvent).toHaveBeenCalledTimes(2);
    });

    it("should reset sequence tracking", () => {
      router.route(
        makeEvent({ kind: "text_delta", content: "a" } as TextDeltaEvent, 10)
      );
      router.resetSequence();
      router.route(
        makeEvent({ kind: "text_delta", content: "b" } as TextDeltaEvent, 1)
      );

      expect(chat.postEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("multiple event types in sequence", () => {
    it("should correctly route a mix of event types", () => {
      const events: GatewayEvent[] = [
        makeEvent({ kind: "text_delta", content: "Hello" } as TextDeltaEvent, 1),
        makeEvent({
          kind: "tool_start",
          tool: "edit",
          id: "t1",
        } as ToolStartEvent, 2),
        makeEvent({
          kind: "a2ui",
          payload: { type: "updateDataModel" },
        } as A2UIEvent, 3),
        makeEvent({
          kind: "diff",
          path: "x.ts",
          original: "a",
          modified: "b",
        } as DiffEvent, 4),
        makeEvent({ kind: "done", stopReason: "end_turn" } as DoneEvent, 5),
      ];

      for (const event of events) {
        router.route(event);
      }

      // chat receives: text_delta, tool_start, diff, done = 4
      expect(chat.postEvent).toHaveBeenCalledTimes(4);
      // canvas receives: a2ui = 1
      expect(canvas.postV08Messages).toHaveBeenCalledTimes(1);
      // bridge receives: diff = 1
      expect(bridge.showDiff).toHaveBeenCalledTimes(1);
    });
  });
});
