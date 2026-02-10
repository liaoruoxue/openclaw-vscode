import type {
  GatewayEvent,
  AgentEventPayload,
  A2UIMessage,
} from "./types";
import type { ChatProvider } from "../vscode/chatProvider";
import type { CanvasPanel } from "../vscode/canvasPanel";
import type { VSCodeBridge } from "../vscode/bridge";

/** Minimal interface for the chat target — makes the router testable. */
export interface ChatTarget {
  postEvent(event: AgentEventPayload): void;
}

/** Minimal interface for the canvas target. */
export interface CanvasTarget {
  postA2UIMessage(message: A2UIMessage): void;
}

/** Minimal interface for the VS Code bridge target. */
export interface BridgeTarget {
  showDiff(original: string, modified: string, title: string): void;
}

export class MessageRouter {
  private lastSeq = -1;

  constructor(
    private chat: ChatTarget,
    private canvas: CanvasTarget,
    private bridge: BridgeTarget
  ) {}

  route(event: GatewayEvent): void {
    // Track sequence numbers for ordering if provided
    if (event.seq !== undefined) {
      if (event.seq <= this.lastSeq) {
        return; // Drop duplicate / out-of-order events
      }
      this.lastSeq = event.seq;
    }

    const payload = event.payload;

    switch (payload.kind) {
      case "text_delta":
      case "tool_start":
      case "tool_result":
      case "done":
        this.chat.postEvent(payload);
        break;

      case "a2ui":
        this.canvas.postA2UIMessage(payload.payload);
        break;

      case "diff":
        this.chat.postEvent(payload);
        this.bridge.showDiff(
          payload.original ?? "",
          payload.modified,
          payload.path
        );
        break;
    }
  }

  /** Reset sequence tracking (e.g. on new session). */
  resetSequence(): void {
    this.lastSeq = -1;
  }
}
