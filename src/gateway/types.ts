// Gateway event types — based on OpenClaw Gateway Protocol v3

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, unknown>;
  auth?: {
    token: string;
  };
  device?: Record<string, unknown>;
}

export interface ChatSendParams {
  session: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface GatewayRequest {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface GatewayResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
}

export interface GatewayEvent {
  type: "event";
  event: string;
  payload: AgentEventPayload;
  seq?: number;
  stateVersion?: number;
}

export type AgentEventPayload =
  | TextDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | A2UIEvent
  | DiffEvent
  | DoneEvent;

export interface TextDeltaEvent {
  kind: "text_delta";
  content: string;
}

export interface ToolStartEvent {
  kind: "tool_start";
  tool: string;
  id: string;
  title?: string;
  input?: Record<string, unknown>;
}

export interface ToolResultEvent {
  kind: "tool_result";
  id: string;
  output: unknown;
  error?: string;
}

export interface A2UIEvent {
  kind: "a2ui";
  payload: A2UIMessage;
}

export interface A2UIMessage {
  type: "createSurface" | "updateComponents" | "updateDataModel";
  [key: string]: unknown;
}

export interface DiffEvent {
  kind: "diff";
  path: string;
  original: string | null;
  modified: string;
}

export interface DoneEvent {
  kind: "done";
  stopReason: string;
}

export interface ChatOptions {
  context?: Record<string, unknown>;
}

export interface Session {
  key: string;
  agent?: string;
  label?: string;
  createdAt?: string;
}

/** Gateway historical message — content can be string or content-parts array */
export interface HistoricalMessage {
  role: "user" | "assistant";
  content: unknown;
  toolCalls?: unknown[];
}
