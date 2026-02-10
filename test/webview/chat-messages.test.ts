/**
 * Tests for the Chat webview message handling logic.
 *
 * Since chat/index.tsx has side effects at module scope (acquireVsCodeApi, createRoot),
 * we test the message handling logic by simulating postMessage events against a
 * lightweight reimplementation of the core state reducer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Replicate core types from chat/index.tsx ---

interface ToolCall {
  id: string;
  tool: string;
  title?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  done: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCall[];
}

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  connectionState: string;
  sessions: Array<{ key: string; label?: string }>;
  currentSession: string | null;
  injectedText: string;
}

/**
 * Mirrors the switch-case logic in the Chat App's useEffect message handler.
 * Extracted here for testability.
 */
function reduceMessage(state: ChatState, msg: Record<string, unknown>): ChatState {
  const kind = (msg.kind ?? msg.type) as string;
  const next = { ...state };

  switch (kind) {
    case "text_delta": {
      next.streaming = true;
      const last = next.messages[next.messages.length - 1];
      if (last?.role === "assistant") {
        next.messages = [
          ...next.messages.slice(0, -1),
          { ...last, content: last.content + (msg.content as string) },
        ];
      } else {
        next.messages = [
          ...next.messages,
          { role: "assistant", content: msg.content as string, toolCalls: [] },
        ];
      }
      break;
    }

    case "tool_start": {
      next.streaming = true;
      const tc: ToolCall = {
        id: msg.id as string,
        tool: msg.tool as string,
        title: msg.title as string | undefined,
        input: msg.input as Record<string, unknown> | undefined,
        done: false,
      };
      const last = next.messages[next.messages.length - 1];
      if (last?.role === "assistant") {
        next.messages = [
          ...next.messages.slice(0, -1),
          { ...last, toolCalls: [...last.toolCalls, tc] },
        ];
      } else {
        next.messages = [
          ...next.messages,
          { role: "assistant", content: "", toolCalls: [tc] },
        ];
      }
      break;
    }

    case "tool_result": {
      const last = next.messages[next.messages.length - 1];
      if (last?.role === "assistant") {
        const updatedCalls = last.toolCalls.map((tc) =>
          tc.id === msg.id
            ? { ...tc, output: msg.output, error: msg.error as string | undefined, done: true }
            : tc
        );
        next.messages = [
          ...next.messages.slice(0, -1),
          { ...last, toolCalls: updatedCalls },
        ];
      }
      break;
    }

    case "done":
      next.streaming = false;
      break;

    case "inject_prompt":
      next.injectedText = msg.text as string;
      break;

    case "connection_state":
      next.connectionState = msg.state as string;
      break;

    case "sessions":
      next.sessions = msg.sessions as ChatState["sessions"];
      break;

    case "error":
      next.streaming = false;
      next.messages = [
        ...next.messages,
        { role: "assistant", content: `Error: ${msg.message}`, toolCalls: [] },
      ];
      break;

    case "history": {
      next.messages = (msg.messages as ChatMessage[]) ?? [];
      next.streaming = false;
      break;
    }

    case "history_loading":
      next.messages = [];
      next.streaming = false;
      break;

    case "session_created": {
      const session = msg.session as { key: string; label?: string };
      next.sessions = [...next.sessions, session];
      next.currentSession = session.key;
      next.messages = [];
      break;
    }

    case "reconnected":
      next.streaming = false;
      next.messages = [
        ...next.messages,
        {
          role: "assistant",
          content: "Connection restored. If your last message was interrupted, please resend it.",
          toolCalls: [],
        },
      ];
      break;
  }

  return next;
}

function emptyState(): ChatState {
  return {
    messages: [],
    streaming: false,
    connectionState: "disconnected",
    sessions: [],
    currentSession: null,
    injectedText: "",
  };
}

describe("Chat webview message handling", () => {
  describe("text_delta", () => {
    it("should create a new assistant message for first delta", () => {
      const state = reduceMessage(emptyState(), { kind: "text_delta", content: "Hello" });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual({
        role: "assistant",
        content: "Hello",
        toolCalls: [],
      });
      expect(state.streaming).toBe(true);
    });

    it("should append to existing assistant message", () => {
      let state = reduceMessage(emptyState(), { kind: "text_delta", content: "Hello" });
      state = reduceMessage(state, { kind: "text_delta", content: " world" });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("Hello world");
    });

    it("should create new assistant message after user message", () => {
      const initial: ChatState = {
        ...emptyState(),
        messages: [{ role: "user", content: "hi", toolCalls: [] }],
      };
      const state = reduceMessage(initial, { kind: "text_delta", content: "Hey" });
      expect(state.messages).toHaveLength(2);
      expect(state.messages[1].role).toBe("assistant");
      expect(state.messages[1].content).toBe("Hey");
    });
  });

  describe("tool_start / tool_result", () => {
    it("should add tool call to current assistant message", () => {
      let state = reduceMessage(emptyState(), { kind: "text_delta", content: "Let me check..." });
      state = reduceMessage(state, {
        kind: "tool_start",
        id: "t1",
        tool: "readFile",
        title: "Reading file",
        input: { path: "src/main.ts" },
      });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].toolCalls).toHaveLength(1);
      expect(state.messages[0].toolCalls[0]).toMatchObject({
        id: "t1",
        tool: "readFile",
        done: false,
      });
    });

    it("should mark tool as done on tool_result", () => {
      let state = reduceMessage(emptyState(), { kind: "text_delta", content: "Checking..." });
      state = reduceMessage(state, {
        kind: "tool_start",
        id: "t1",
        tool: "readFile",
      });
      state = reduceMessage(state, {
        kind: "tool_result",
        id: "t1",
        output: "file contents",
      });
      expect(state.messages[0].toolCalls[0].done).toBe(true);
      expect(state.messages[0].toolCalls[0].output).toBe("file contents");
    });

    it("should handle tool_result with error", () => {
      let state = reduceMessage(emptyState(), {
        kind: "tool_start",
        id: "t1",
        tool: "readFile",
      });
      state = reduceMessage(state, {
        kind: "tool_result",
        id: "t1",
        error: "file not found",
      });
      expect(state.messages[0].toolCalls[0].done).toBe(true);
      expect(state.messages[0].toolCalls[0].error).toBe("file not found");
    });

    it("should handle multiple tool calls in one message", () => {
      let state = reduceMessage(emptyState(), { kind: "text_delta", content: "" });
      state = reduceMessage(state, { kind: "tool_start", id: "t1", tool: "read" });
      state = reduceMessage(state, { kind: "tool_start", id: "t2", tool: "write" });
      expect(state.messages[0].toolCalls).toHaveLength(2);
      state = reduceMessage(state, { kind: "tool_result", id: "t1", output: "ok" });
      expect(state.messages[0].toolCalls[0].done).toBe(true);
      expect(state.messages[0].toolCalls[1].done).toBe(false);
    });
  });

  describe("done", () => {
    it("should stop streaming", () => {
      let state = reduceMessage(emptyState(), { kind: "text_delta", content: "Hi" });
      expect(state.streaming).toBe(true);
      state = reduceMessage(state, { kind: "done" });
      expect(state.streaming).toBe(false);
    });
  });

  describe("connection_state", () => {
    it("should update connection state", () => {
      const state = reduceMessage(emptyState(), { type: "connection_state", state: "connected" });
      expect(state.connectionState).toBe("connected");
    });
  });

  describe("sessions", () => {
    it("should update sessions list", () => {
      const sessions = [{ key: "s1", label: "Session 1" }, { key: "s2" }];
      const state = reduceMessage(emptyState(), { type: "sessions", sessions });
      expect(state.sessions).toEqual(sessions);
    });
  });

  describe("error", () => {
    it("should add error message and stop streaming", () => {
      let state = reduceMessage(emptyState(), { kind: "text_delta", content: "partial" });
      state = reduceMessage(state, { type: "error", message: "timeout" });
      expect(state.streaming).toBe(false);
      expect(state.messages).toHaveLength(2);
      expect(state.messages[1].content).toBe("Error: timeout");
    });
  });

  describe("history", () => {
    it("should replace messages with history", () => {
      const initial: ChatState = {
        ...emptyState(),
        messages: [{ role: "user", content: "old", toolCalls: [] }],
        streaming: true,
      };
      const historyMessages: ChatMessage[] = [
        { role: "user", content: "hello", toolCalls: [] },
        { role: "assistant", content: "world", toolCalls: [] },
      ];
      const state = reduceMessage(initial, { type: "history", messages: historyMessages });
      expect(state.messages).toEqual(historyMessages);
      expect(state.streaming).toBe(false);
    });

    it("should handle null messages gracefully", () => {
      const state = reduceMessage(emptyState(), { type: "history", messages: null });
      expect(state.messages).toEqual([]);
    });
  });

  describe("history_loading", () => {
    it("should clear messages and stop streaming", () => {
      const initial: ChatState = {
        ...emptyState(),
        messages: [{ role: "user", content: "x", toolCalls: [] }],
        streaming: true,
      };
      const state = reduceMessage(initial, { type: "history_loading" });
      expect(state.messages).toEqual([]);
      expect(state.streaming).toBe(false);
    });
  });

  describe("session_created", () => {
    it("should add session, switch to it, and clear messages", () => {
      const initial: ChatState = {
        ...emptyState(),
        sessions: [{ key: "s1" }],
        messages: [{ role: "user", content: "old", toolCalls: [] }],
      };
      const state = reduceMessage(initial, {
        type: "session_created",
        session: { key: "s2", label: "New" },
      });
      expect(state.sessions).toHaveLength(2);
      expect(state.currentSession).toBe("s2");
      expect(state.messages).toEqual([]);
    });
  });

  describe("inject_prompt", () => {
    it("should set injected text", () => {
      const state = reduceMessage(emptyState(), { type: "inject_prompt", text: "code here" });
      expect(state.injectedText).toBe("code here");
    });
  });

  describe("reconnected", () => {
    it("should add reconnection message and stop streaming", () => {
      const initial: ChatState = { ...emptyState(), streaming: true };
      const state = reduceMessage(initial, { type: "reconnected" });
      expect(state.streaming).toBe(false);
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toContain("Connection restored");
    });
  });

  describe("full conversation flow", () => {
    it("should handle user → assistant → tool → done sequence", () => {
      let state: ChatState = {
        ...emptyState(),
        connectionState: "connected",
        messages: [{ role: "user", content: "help me", toolCalls: [] }],
      };

      // Assistant starts typing
      state = reduceMessage(state, { kind: "text_delta", content: "Sure, " });
      state = reduceMessage(state, { kind: "text_delta", content: "let me check." });
      expect(state.messages[1].content).toBe("Sure, let me check.");

      // Tool call
      state = reduceMessage(state, {
        kind: "tool_start",
        id: "t1",
        tool: "readFile",
        title: "Reading config",
      });
      expect(state.messages[1].toolCalls).toHaveLength(1);

      // Tool result
      state = reduceMessage(state, {
        kind: "tool_result",
        id: "t1",
        output: "config data",
      });
      expect(state.messages[1].toolCalls[0].done).toBe(true);

      // More text
      state = reduceMessage(state, { kind: "text_delta", content: "\nHere's what I found." });
      expect(state.messages[1].content).toBe("Sure, let me check.\nHere's what I found.");

      // Done
      state = reduceMessage(state, { kind: "done" });
      expect(state.streaming).toBe(false);
      expect(state.messages).toHaveLength(2);
    });
  });
});
