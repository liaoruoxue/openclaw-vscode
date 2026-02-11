import React from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";

// Configure marked: synchronous, GFM with line breaks
marked.setOptions({ async: false, breaks: true, gfm: true });

// @ts-expect-error — acquireVsCodeApi is injected by VS Code webview runtime
const vscode = acquireVsCodeApi();

// --- Types ---

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface Session {
  key: string;
  label?: string;
}

interface ToolCall {
  id: string;
  tool: string;
  title?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  done: boolean;
}

interface DiffInfo {
  id: string;
  path: string;
  original: string | null;
  modified: string;
  status: "pending" | "accepted" | "rejected";
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCall[];
  diffs: DiffInfo[];
}

// --- ToolCallView ---

function ToolCallView({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      style={{
        margin: "4px 0",
        border: "1px solid var(--vscode-panel-border, #444)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: "4px 8px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "var(--vscode-editor-inactiveSelectionBackground, #264f78)",
          fontSize: 12,
        }}
      >
        <span style={{ fontFamily: "monospace" }}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={{ fontWeight: 600 }}>
          {toolCall.title ?? toolCall.tool}
        </span>
        {!toolCall.done && (
          <span style={{ opacity: 0.6, marginLeft: "auto" }}>running...</span>
        )}
        {toolCall.error && (
          <span style={{ color: "var(--vscode-errorForeground, #f44)", marginLeft: "auto" }}>
            error
          </span>
        )}
      </div>
      {expanded && (
        <div style={{ padding: 8, fontSize: 12 }}>
          {toolCall.input && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ opacity: 0.7, marginBottom: 2 }}>Input:</div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  background: "var(--vscode-editor-background, #1e1e1e)",
                  padding: 6,
                  borderRadius: 3,
                }}
              >
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.output !== undefined && (
            <div>
              <div style={{ opacity: 0.7, marginBottom: 2 }}>Output:</div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  background: "var(--vscode-editor-background, #1e1e1e)",
                  padding: 6,
                  borderRadius: 3,
                }}
              >
                {typeof toolCall.output === "string"
                  ? toolCall.output
                  : JSON.stringify(toolCall.output, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.error && (
            <div style={{ color: "var(--vscode-errorForeground, #f44)" }}>
              Error: {toolCall.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- MarkdownContent ---

function MarkdownContent({ content }: { content: string }) {
  const html = React.useMemo(
    () => marked.parse(content, { async: false }) as string,
    [content]
  );
  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// --- ActionButton ---

function ActionButton({
  label,
  onClick,
  title,
}: {
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: "none",
        border: "1px solid var(--vscode-panel-border, #555)",
        borderRadius: 3,
        color: "var(--vscode-foreground, #ccc)",
        cursor: "pointer",
        fontSize: 11,
        padding: "1px 6px",
        opacity: 0.7,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
    >
      {label}
    </button>
  );
}

// --- CopyFeedback helper ---

function useCopyFeedback(): [string | null, (text: string) => void] {
  const [copied, setCopied] = React.useState<string | null>(null);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied("Copied!");
      setTimeout(() => setCopied(null), 1500);
    });
  };
  return [copied, copy];
}

// --- DiffBlock ---

function DiffBlock({
  diff,
  onAccept,
  onReject,
}: {
  diff: DiffInfo;
  onAccept: (diff: DiffInfo) => void;
  onReject: (diff: DiffInfo) => void;
}) {
  const isNewFile = diff.original === null;
  const statusColors = {
    pending: "var(--vscode-panel-border, #555)",
    accepted: "#4caf50",
    rejected: "#f44336",
  };
  const statusLabels = {
    pending: isNewFile ? "New file" : "Modified",
    accepted: "Accepted",
    rejected: "Rejected",
  };

  return (
    <div
      style={{
        margin: "4px 0",
        border: `1px solid ${statusColors[diff.status]}`,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "4px 8px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "var(--vscode-editor-inactiveSelectionBackground, #264f78)",
          fontSize: 12,
        }}
      >
        <span style={{ fontFamily: "monospace", opacity: 0.7 }}>
          {isNewFile ? "+" : "~"}
        </span>
        <span style={{ fontWeight: 600, flex: 1 }}>{diff.path}</span>
        <span
          style={{
            fontSize: 11,
            color: statusColors[diff.status],
            marginRight: 4,
          }}
        >
          {statusLabels[diff.status]}
        </span>
        {diff.status === "pending" && (
          <>
            <button
              onClick={() => onAccept(diff)}
              style={{
                background: "#4caf50",
                color: "#fff",
                border: "none",
                borderRadius: 3,
                padding: "1px 8px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Accept
            </button>
            <button
              onClick={() => onReject(diff)}
              style={{
                background: "none",
                border: "1px solid var(--vscode-panel-border, #555)",
                borderRadius: 3,
                color: "var(--vscode-foreground, #ccc)",
                padding: "1px 8px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// --- MessageBubble ---

function MessageBubble({
  message,
  onResend,
  onAcceptDiff,
  onRejectDiff,
}: {
  message: ChatMessage;
  onResend?: (text: string) => void;
  onAcceptDiff: (diff: DiffInfo) => void;
  onRejectDiff: (diff: DiffInfo) => void;
}) {
  const isUser = message.role === "user";
  const [hovered, setHovered] = React.useState(false);
  const [copied, copy] = useCopyFeedback();
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Attach copy + open-in-editor buttons to code blocks in rendered markdown
  React.useEffect(() => {
    if (isUser || !contentRef.current) return;
    const pres = contentRef.current.querySelectorAll("pre");
    pres.forEach((pre) => {
      if (pre.querySelector(".code-btn-container")) return;

      const codeEl = pre.querySelector("code");
      const code = codeEl?.textContent ?? pre.textContent ?? "";
      // Extract language from class like "language-typescript"
      const langClass = Array.from(codeEl?.classList ?? []).find((c) => c.startsWith("language-"));
      const language = langClass?.replace("language-", "") ?? "";

      const container = document.createElement("div");
      container.className = "code-btn-container";
      container.style.cssText =
        "position:absolute;top:4px;right:4px;display:flex;gap:4px;opacity:0;transition:opacity 0.15s;";

      const btnStyle =
        "background:var(--vscode-button-secondaryBackground,#444);" +
        "color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:3px;" +
        "padding:2px 8px;font-size:11px;cursor:pointer;";

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy";
      copyBtn.title = "Copy code";
      copyBtn.style.cssText = btnStyle;
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        });
      });

      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.title = "Open in editor";
      openBtn.style.cssText = btnStyle;
      openBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "openInEditor", code, language });
      });

      container.appendChild(copyBtn);
      container.appendChild(openBtn);
      pre.style.position = "relative";
      pre.appendChild(container);
      pre.addEventListener("mouseenter", () => { container.style.opacity = "1"; });
      pre.addEventListener("mouseleave", () => { container.style.opacity = "0"; });
    });
  }, [message.content, isUser]);

  return (
    <div
      style={{ marginBottom: 12, position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 12, opacity: 0.7 }}>
          {isUser ? "You" : "Agent"}
        </span>
        {hovered && (
          <span style={{ display: "flex", gap: 4 }}>
            {isUser && onResend && (
              <ActionButton
                label="Resend"
                title="Resend this message"
                onClick={() => onResend(message.content)}
              />
            )}
            {!isUser && message.content && (
              <ActionButton
                label={copied ?? "Copy"}
                title="Copy message"
                onClick={() => copy(message.content)}
              />
            )}
          </span>
        )}
      </div>
      {isUser ? (
        <div
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            padding: "6px 10px",
            borderRadius: 6,
            background: "var(--vscode-input-background, #3c3c3c)",
          }}
        >
          {message.content}
        </div>
      ) : (
        <div
          ref={contentRef}
          style={{
            wordBreak: "break-word",
            padding: "6px 10px",
            borderRadius: 6,
          }}
        >
          <MarkdownContent content={message.content} />
        </div>
      )}
      {message.toolCalls.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {message.toolCalls.map((tc) => (
            <ToolCallView key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
      {message.diffs.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {message.diffs.map((d) => (
            <DiffBlock
              key={d.id}
              diff={d}
              onAccept={onAcceptDiff}
              onReject={onRejectDiff}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- MessageList ---

function MessageList({
  messages,
  streaming,
  onResend,
  onAcceptDiff,
  onRejectDiff,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onResend: (text: string) => void;
  onAcceptDiff: (diff: DiffInfo) => void;
  onRejectDiff: (diff: DiffInfo) => void;
}) {
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
      {messages.length === 0 && (
        <div style={{ opacity: 0.5, textAlign: "center", marginTop: 24 }}>
          Send a message to get started.
        </div>
      )}
      {messages.map((m, i) => (
        <MessageBubble
          key={i}
          message={m}
          onResend={onResend}
          onAcceptDiff={onAcceptDiff}
          onRejectDiff={onRejectDiff}
        />
      ))}
      {streaming && (
        <div style={{ opacity: 0.5, fontSize: 12, padding: "0 10px" }}>
          Thinking...
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

// --- InputBar ---

function InputBar({
  streaming,
  disabled,
  onSend,
  onAbort,
  injectedText,
  onClearInjected,
}: {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  injectedText: string;
  onClearInjected: () => void;
}) {
  const [input, setInput] = React.useState("");
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (injectedText) {
      setInput(injectedText);
      onClearInjected();
      inputRef.current?.focus();
    }
  }, [injectedText]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        padding: 8,
        gap: 4,
        borderTop: "1px solid var(--vscode-panel-border, #444)",
        alignItems: "flex-end",
      }}
    >
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask OpenClaw..."
        disabled={disabled}
        rows={1}
        style={{
          flex: 1,
          resize: "vertical",
          minHeight: 28,
          maxHeight: 120,
          padding: "4px 8px",
          background: "var(--vscode-input-background, #3c3c3c)",
          color: "var(--vscode-input-foreground, #ccc)",
          border: "1px solid var(--vscode-input-border, #555)",
          borderRadius: 4,
          fontFamily: "inherit",
          fontSize: 13,
        }}
      />
      {streaming ? (
        <button
          onClick={onAbort}
          style={{
            padding: "4px 12px",
            background: "var(--vscode-button-secondaryBackground, #555)",
            color: "var(--vscode-button-secondaryForeground, #fff)",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Stop
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          style={{
            padding: "4px 12px",
            background: "var(--vscode-button-background, #0e639c)",
            color: "var(--vscode-button-foreground, #fff)",
            border: "none",
            borderRadius: 4,
            cursor: disabled || !input.trim() ? "default" : "pointer",
            opacity: disabled || !input.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}

// --- StatusBar ---

function StatusBar({
  connectionState,
  sessions,
  currentSession,
  onSwitchSession,
  onCreateSession,
}: {
  connectionState: ConnectionState;
  sessions: Session[];
  currentSession: string | null;
  onSwitchSession: (key: string) => void;
  onCreateSession: () => void;
}) {
  const stateColors: Record<ConnectionState, string> = {
    connected: "#4caf50",
    connecting: "#ff9800",
    disconnected: "#888",
    error: "#f44336",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "4px 8px",
        gap: 8,
        borderBottom: "1px solid var(--vscode-panel-border, #444)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: stateColors[connectionState],
            display: "inline-block",
          }}
        />
        <span style={{ opacity: 0.7 }}>{connectionState}</span>
      </div>
      {sessions.length > 0 && (
        <select
          value={currentSession ?? ""}
          onChange={(e) => onSwitchSession(e.target.value)}
          style={{
            marginLeft: "auto",
            background: "var(--vscode-dropdown-background, #3c3c3c)",
            color: "var(--vscode-dropdown-foreground, #ccc)",
            border: "1px solid var(--vscode-dropdown-border, #555)",
            borderRadius: 3,
            fontSize: 12,
            padding: "1px 4px",
          }}
        >
          {sessions.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label ?? s.key}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={onCreateSession}
        disabled={connectionState !== "connected"}
        title="New session"
        style={{
          marginLeft: sessions.length > 0 ? 0 : "auto",
          background: "none",
          border: "1px solid var(--vscode-panel-border, #444)",
          borderRadius: 3,
          color: "var(--vscode-foreground, #ccc)",
          cursor: connectionState === "connected" ? "pointer" : "default",
          opacity: connectionState === "connected" ? 1 : 0.4,
          fontSize: 14,
          lineHeight: 1,
          padding: "1px 5px",
        }}
      >
        +
      </button>
    </div>
  );
}

// --- App ---

function App() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [connectionState, setConnectionState] =
    React.useState<ConnectionState>("disconnected");
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [currentSession, setCurrentSession] = React.useState<string | null>(
    null
  );
  const [injectedText, setInjectedText] = React.useState("");

  // Track in-progress tool calls for the current assistant message
  const toolCallMapRef = React.useRef<Map<string, ToolCall>>(new Map());

  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      const kind = msg.kind ?? msg.type;

      switch (kind) {
        case "text_delta": {
          setStreaming(true);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + msg.content },
              ];
            }
            return [
              ...prev,
              { role: "assistant", content: msg.content, toolCalls: [], diffs: [] },
            ];
          });
          break;
        }

        case "tool_start": {
          setStreaming(true);
          const tc: ToolCall = {
            id: msg.id,
            tool: msg.tool,
            title: msg.title,
            input: msg.input,
            done: false,
          };
          toolCallMapRef.current.set(msg.id, tc);

          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [
                ...prev.slice(0, -1),
                { ...last, toolCalls: [...last.toolCalls, tc] },
              ];
            }
            return [
              ...prev,
              { role: "assistant", content: "", toolCalls: [tc], diffs: [] },
            ];
          });
          break;
        }

        case "tool_result": {
          const existing = toolCallMapRef.current.get(msg.id);
          if (existing) {
            existing.output = msg.output;
            existing.error = msg.error;
            existing.done = true;
          }

          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              const updatedCalls = last.toolCalls.map((tc) =>
                tc.id === msg.id
                  ? { ...tc, output: msg.output, error: msg.error, done: true }
                  : tc
              );
              return [
                ...prev.slice(0, -1),
                { ...last, toolCalls: updatedCalls },
              ];
            }
            return prev;
          });
          break;
        }

        case "diff": {
          setStreaming(true);
          const diffInfo: DiffInfo = {
            id: crypto.randomUUID(),
            path: msg.path as string,
            original: (msg.original as string | null) ?? null,
            modified: msg.modified as string,
            status: "pending",
          };
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [
                ...prev.slice(0, -1),
                { ...last, diffs: [...last.diffs, diffInfo] },
              ];
            }
            return [
              ...prev,
              { role: "assistant", content: "", toolCalls: [], diffs: [diffInfo] },
            ];
          });
          break;
        }

        case "done":
          setStreaming(false);
          toolCallMapRef.current.clear();
          break;

        case "inject_prompt":
          setInjectedText(msg.text);
          break;

        case "inject_and_send":
          setMessages((prev) => [
            ...prev,
            { role: "user", content: msg.text, toolCalls: [], diffs: [] },
          ]);
          setStreaming(true);
          break;

        case "connection_state":
          setConnectionState(msg.state as ConnectionState);
          // If connection drops while streaming, unstick the UI
          if (msg.state === "disconnected" || msg.state === "error") {
            if (streaming) {
              setStreaming(false);
            }
          }
          break;

        case "sessions":
          setSessions(msg.sessions as Session[]);
          break;

        case "error":
          setStreaming(false);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Error: ${msg.message}`,
              toolCalls: [],
              diffs: [],
            },
          ]);
          break;

        case "history": {
          const historyMessages = (msg.messages as ChatMessage[]) ?? [];
          setMessages(historyMessages);
          setStreaming(false);
          toolCallMapRef.current.clear();
          break;
        }

        case "history_loading":
          setMessages([]);
          setStreaming(false);
          toolCallMapRef.current.clear();
          break;

        case "session_created": {
          const session = msg.session as Session;
          setSessions((prev) => [...prev, session]);
          setCurrentSession(session.key);
          setMessages([]);
          toolCallMapRef.current.clear();
          break;
        }

        case "reconnected":
          setStreaming(false);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content:
                "Connection restored. If your last message was interrupted, please resend it.",
              toolCalls: [],
              diffs: [],
            },
          ]);
          break;
      }
    };

    window.addEventListener("message", handler);
    // Request sessions on mount
    vscode.postMessage({ type: "request_sessions" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleSend = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, toolCalls: [], diffs: [] },
    ]);
    vscode.postMessage({ type: "send", text });
    setStreaming(true);
  };

  const handleAbort = () => {
    vscode.postMessage({ type: "abort" });
    setStreaming(false);
  };

  const handleSwitchSession = (key: string) => {
    setCurrentSession(key);
    setMessages([]);
    toolCallMapRef.current.clear();
    vscode.postMessage({ type: "switch_session", key });
  };

  const handleCreateSession = () => {
    vscode.postMessage({ type: "create_session" });
  };

  const handleAcceptDiff = (diff: DiffInfo) => {
    vscode.postMessage({
      type: "applyDiff",
      path: diff.path,
      content: diff.modified,
      isNewFile: diff.original === null,
    });
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        diffs: m.diffs.map((d) =>
          d.id === diff.id ? { ...d, status: "accepted" as const } : d
        ),
      }))
    );
  };

  const handleRejectDiff = (diff: DiffInfo) => {
    vscode.postMessage({ type: "rejectDiff", path: diff.path });
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        diffs: m.diffs.map((d) =>
          d.id === diff.id ? { ...d, status: "rejected" as const } : d
        ),
      }))
    );
  };

  const isDisabled = connectionState !== "connected";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        color: "var(--vscode-foreground, #ccc)",
        fontFamily: "var(--vscode-font-family, sans-serif)",
        fontSize: "var(--vscode-font-size, 13px)",
      }}
    >
      <StatusBar
        connectionState={connectionState}
        sessions={sessions}
        currentSession={currentSession}
        onSwitchSession={handleSwitchSession}
        onCreateSession={handleCreateSession}
      />
      <MessageList
        messages={messages}
        streaming={streaming}
        onResend={handleSend}
        onAcceptDiff={handleAcceptDiff}
        onRejectDiff={handleRejectDiff}
      />
      <InputBar
        streaming={streaming}
        disabled={isDisabled}
        onSend={handleSend}
        onAbort={handleAbort}
        injectedText={injectedText}
        onClearInjected={() => setInjectedText("")}
      />
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
