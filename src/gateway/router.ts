import type {
  GatewayEvent,
  AgentEventPayload,
} from "./types";
import type { ChatProvider } from "../vscode/chatProvider";
import type { CanvasPanel } from "../vscode/canvasPanel";
import type { VSCodeBridge } from "../vscode/bridge";
import { convertMessagesToV08 } from "./a2uiV08";

/** Minimal interface for the chat target — makes the router testable. */
export interface ChatTarget {
  postEvent(event: AgentEventPayload): void;
}

/** Minimal interface for the canvas target. */
export interface CanvasTarget {
  postV08Messages(messages: Record<string, unknown>[]): void;
}

/** Minimal interface for the VS Code bridge target. */
export interface BridgeTarget {
  showDiff(original: string, modified: string, title: string): void;
}

export class MessageRouter {
  private lastSeq = -1;
  private _log: (msg: string) => void = () => {};

  constructor(
    private chat: ChatTarget,
    private canvas: CanvasTarget,
    private bridge: BridgeTarget
  ) {}

  setLogger(fn: (msg: string) => void): void {
    this._log = fn;
  }

  route(event: GatewayEvent): void {
    // Track sequence numbers for ordering if provided
    if (event.seq !== undefined) {
      if (event.seq <= this.lastSeq) {
        this._log(`[router] Dropped seq=${event.seq} (lastSeq=${this.lastSeq}) kind=${event.payload?.kind}`);
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

      case "a2ui": {
        const v08 = convertMessagesToV08([payload.payload as Record<string, unknown>]);
        this.canvas.postV08Messages(v08);
        break;
      }

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
