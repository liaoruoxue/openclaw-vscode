import React from "react";
import { createRoot } from "react-dom/client";

// @ts-expect-error — acquireVsCodeApi is injected by VS Code webview runtime
const vscode = acquireVsCodeApi();

// --- Types ---

interface ComponentDef {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: ComponentDef[];
}

interface Surface {
  id: string;
  title?: string;
  components: ComponentDef[];
  dataModel?: Record<string, unknown>;
}

type ActionHandler = (action: string, context: Record<string, unknown>) => void;

// --- Data Model / JSON Pointer ---

function resolvePointer(data: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  const parts = pointer.slice(1).split("/").map((p) =>
    p.replace(/~1/g, "/").replace(/~0/g, "~")
  );
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Deep-set a value in a nested object by JSON Pointer path, returning a new object (immutable). */
function setByPointer(
  data: Record<string, unknown>,
  pointer: string,
  value: unknown
): Record<string, unknown> {
  if (!pointer.startsWith("/")) return data;
  const parts = pointer.slice(1).split("/").map((p) =>
    p.replace(/~1/g, "/").replace(/~0/g, "~")
  );
  if (parts.length === 0) return data;

  const result = { ...data };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const existing = current[part];
    if (existing != null && typeof existing === "object" && !Array.isArray(existing)) {
      current[part] = { ...(existing as Record<string, unknown>) };
    } else if (Array.isArray(existing)) {
      current[part] = [...existing];
    } else {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

function resolveBoundValue(
  value: unknown,
  dataModel: Record<string, unknown>
): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as Record<string, unknown>).$ref === "string"
  ) {
    return resolvePointer(dataModel, (value as { $ref: string }).$ref);
  }
  return value;
}

function resolveProps(
  props: Record<string, unknown>,
  dataModel: Record<string, unknown>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    resolved[key] = resolveBoundValue(value, dataModel);
  }
  return resolved;
}

// --- Component Registry ---

type ComponentRenderer = React.FC<{
  props: Record<string, unknown>;
  children?: ComponentDef[];
  onAction: ActionHandler;
  dataModel: Record<string, unknown>;
  id: string;
  loading?: boolean;
}>;

const componentRegistry: Map<string, ComponentRenderer> = new Map();

function registerComponent(type: string, renderer: ComponentRenderer) {
  componentRegistry.set(type, renderer);
}

// --- Standard Components ---

// Text
registerComponent("Text", ({ props }) => (
  <p style={{
    margin: "4px 0",
    ...(props.style as React.CSSProperties ?? {}),
  }}>
    {String(props.text ?? "")}
  </p>
));

// Button
registerComponent("Button", ({ props, onAction, id, loading }) => (
  <button
    onClick={() => onAction("onClick", { componentId: id })}
    disabled={Boolean(props.disabled) || loading}
    style={{
      padding: "6px 16px",
      background: "var(--vscode-button-background, #0e639c)",
      color: "var(--vscode-button-foreground, #fff)",
      border: "none",
      borderRadius: 4,
      cursor: props.disabled || loading ? "default" : "pointer",
      opacity: props.disabled || loading ? 0.5 : 1,
      ...(props.style as React.CSSProperties ?? {}),
    }}
  >
    {loading ? "Loading..." : String(props.label ?? "Button")}
  </button>
));

// TextField
registerComponent("TextField", ({ props, onAction, id }) => {
  const [value, setValue] = React.useState(String(props.value ?? ""));

  return (
    <div style={{ margin: "4px 0" }}>
      {props.label != null && (
        <label style={{ display: "block", fontSize: 12, opacity: 0.7, marginBottom: 2 }}>
          {String(props.label)}
        </label>
      )}
      <input
        type="text"
        value={value}
        placeholder={String(props.placeholder ?? "")}
        onChange={(e) => {
          setValue(e.target.value);
          onAction("onChange", { componentId: id, value: e.target.value });
        }}
        style={{
          width: "100%",
          padding: "4px 8px",
          background: "var(--vscode-input-background, #3c3c3c)",
          color: "var(--vscode-input-foreground, #ccc)",
          border: "1px solid var(--vscode-input-border, #555)",
          borderRadius: 4,
          boxSizing: "border-box",
        }}
      />
    </div>
  );
});

// CheckBox
registerComponent("CheckBox", ({ props, onAction, id }) => {
  const [checked, setChecked] = React.useState(Boolean(props.checked));

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "4px 0", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          onAction("onChange", { componentId: id, checked: e.target.checked });
        }}
      />
      {props.label != null && <span>{String(props.label)}</span>}
    </label>
  );
});

// Card
registerComponent("Card", ({ props, children, onAction, dataModel }) => (
  <div
    style={{
      border: "1px solid var(--vscode-panel-border, #444)",
      borderRadius: 6,
      padding: 12,
      margin: "8px 0",
      background: "var(--vscode-editor-background, #1e1e1e)",
      ...(props.style as React.CSSProperties ?? {}),
    }}
  >
    {props.title != null && (
      <h3 style={{ margin: "0 0 8px 0", fontSize: 14 }}>
        {String(props.title)}
      </h3>
    )}
    {children?.map((child) => (
      <RenderComponent
        key={child.id}
        component={child}
        onAction={onAction}
        dataModel={dataModel}
      />
    ))}
  </div>
));

// Row
registerComponent("Row", ({ props, children, onAction, dataModel }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "row",
      gap: Number(props.gap ?? 8),
      alignItems: String(props.align ?? "center"),
      margin: "4px 0",
      ...(props.style as React.CSSProperties ?? {}),
    }}
  >
    {children?.map((child) => (
      <RenderComponent
        key={child.id}
        component={child}
        onAction={onAction}
        dataModel={dataModel}
      />
    ))}
  </div>
));

// Column
registerComponent("Column", ({ props, children, onAction, dataModel }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: Number(props.gap ?? 8),
      margin: "4px 0",
      ...(props.style as React.CSSProperties ?? {}),
    }}
  >
    {children?.map((child) => (
      <RenderComponent
        key={child.id}
        component={child}
        onAction={onAction}
        dataModel={dataModel}
      />
    ))}
  </div>
));

// List
registerComponent("List", ({ props, onAction, id }) => {
  const items = (props.items as Array<{ label: string; value?: string }>) ?? [];
  return (
    <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
      {items.map((item, i) => (
        <li
          key={i}
          style={{ cursor: props.selectable ? "pointer" : "default", padding: "2px 0" }}
          onClick={() => {
            if (props.selectable) {
              onAction("onSelect", { componentId: id, index: i, value: item.value ?? item.label });
            }
          }}
        >
          {item.label}
        </li>
      ))}
    </ul>
  );
});

// Image
registerComponent("Image", ({ props }) => (
  <img
    src={String(props.src ?? "")}
    alt={String(props.alt ?? "")}
    style={{
      maxWidth: "100%",
      borderRadius: 4,
      ...(props.style as React.CSSProperties ?? {}),
    }}
  />
));

// --- Custom Components ---

// CodeBlock
registerComponent("CodeBlock", ({ props }) => (
  <div style={{ margin: "8px 0" }}>
    {props.filename != null && (
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          padding: "4px 12px",
          background: "var(--vscode-editor-background, #1e1e1e)",
          borderTopLeftRadius: 4,
          borderTopRightRadius: 4,
          borderBottom: "1px solid var(--vscode-panel-border, #333)",
        }}
      >
        {String(props.filename)}
        {props.language != null && <span style={{ marginLeft: 8, opacity: 0.5 }}>{String(props.language)}</span>}
      </div>
    )}
    <pre
      style={{
        margin: 0,
        background: "var(--vscode-editor-background, #1e1e1e)",
        padding: 12,
        borderRadius: props.filename ? "0 0 4px 4px" : 4,
        overflow: "auto",
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
      }}
    >
      <code>{String(props.code ?? "")}</code>
    </pre>
  </div>
));

// FileTree
interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

function FileTreeItem({
  node,
  depth,
  onAction,
}: {
  node: FileTreeNode;
  depth: number;
  onAction: ActionHandler;
}) {
  const [expanded, setExpanded] = React.useState(depth < 1);
  const isDir = node.type === "directory";
  const icon = isDir ? (expanded ? "\u{1F4C2}" : "\u{1F4C1}") : "\u{1F4C4}";

  return (
    <div>
      <div
        onClick={() => {
          if (isDir) {
            setExpanded(!expanded);
          } else {
            onAction("onSelect", { path: node.path });
          }
        }}
        style={{
          padding: "2px 4px",
          paddingLeft: depth * 16 + 4,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 13,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background =
            "var(--vscode-list-hoverBackground, #2a2d2e)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span>{node.name}</span>
      </div>
      {isDir && expanded && node.children?.map((child, i) => (
        <FileTreeItem key={i} node={child} depth={depth + 1} onAction={onAction} />
      ))}
    </div>
  );
}

registerComponent("FileTree", ({ props, onAction }) => {
  // Support both flat items (string[]) and tree structure
  const items = props.items as (string[] | FileTreeNode[]) | undefined;
  if (!items || items.length === 0) {
    return <div style={{ opacity: 0.5, fontSize: 12 }}>No files</div>;
  }

  // Flat string list
  if (typeof items[0] === "string") {
    return (
      <div style={{ margin: "4px 0" }}>
        {(items as string[]).map((item, i) => (
          <div
            key={i}
            style={{
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={() => onAction("onSelect", { path: item })}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "var(--vscode-list-hoverBackground, #2a2d2e)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <span style={{ fontSize: 14 }}>{"\u{1F4C4}"}</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    );
  }

  // Tree structure
  return (
    <div style={{ margin: "4px 0" }}>
      {(items as FileTreeNode[]).map((node, i) => (
        <FileTreeItem key={i} node={node} depth={0} onAction={onAction} />
      ))}
    </div>
  );
});

// DiffView
registerComponent("DiffView", ({ props }) => {
  const original = String(props.original ?? "");
  const modified = String(props.modified ?? "");
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  return (
    <div
      style={{
        margin: "8px 0",
        border: "1px solid var(--vscode-panel-border, #444)",
        borderRadius: 4,
        overflow: "auto",
        fontSize: 13,
        fontFamily: "var(--vscode-editor-font-family, monospace)",
      }}
    >
      {props.title != null && (
        <div style={{ padding: "4px 8px", fontSize: 12, opacity: 0.7, borderBottom: "1px solid var(--vscode-panel-border, #333)" }}>
          {String(props.title)}
        </div>
      )}
      <div style={{ display: "flex" }}>
        <div style={{ flex: 1, borderRight: "1px solid var(--vscode-panel-border, #333)" }}>
          <div style={{ padding: "2px 8px", fontSize: 11, opacity: 0.5, borderBottom: "1px solid var(--vscode-panel-border, #333)" }}>
            Original
          </div>
          <pre style={{ margin: 0, padding: 8, whiteSpace: "pre-wrap" }}>
            {originalLines.map((line, i) => (
              <div key={i} style={{ opacity: modifiedLines[i] !== line ? 1 : 0.5 }}>
                <span style={{ display: "inline-block", width: 30, textAlign: "right", marginRight: 8, opacity: 0.4 }}>{i + 1}</span>
                <span style={modifiedLines[i] !== line ? { background: "rgba(255,0,0,0.15)" } : {}}>{line}</span>
              </div>
            ))}
          </pre>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ padding: "2px 8px", fontSize: 11, opacity: 0.5, borderBottom: "1px solid var(--vscode-panel-border, #333)" }}>
            Modified
          </div>
          <pre style={{ margin: 0, padding: 8, whiteSpace: "pre-wrap" }}>
            {modifiedLines.map((line, i) => (
              <div key={i} style={{ opacity: originalLines[i] !== line ? 1 : 0.5 }}>
                <span style={{ display: "inline-block", width: 30, textAlign: "right", marginRight: 8, opacity: 0.4 }}>{i + 1}</span>
                <span style={originalLines[i] !== line ? { background: "rgba(0,255,0,0.15)" } : {}}>{line}</span>
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
});

// Terminal
const ANSI_COLORS: Record<string, string> = {
  "30": "#000", "31": "#cd3131", "32": "#0dbc79", "33": "#e5e510",
  "34": "#2472c8", "35": "#bc3fbc", "36": "#11a8cd", "37": "#e5e5e5",
  "90": "#666", "91": "#f14c4c", "92": "#23d18b", "93": "#f5f543",
  "94": "#3b8eea", "95": "#d670d6", "96": "#29b8db", "97": "#fff",
};

function parseAnsi(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentColor: string | undefined;
  let bold = false;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const chunk = text.slice(lastIndex, match.index);
      parts.push(
        <span key={parts.length} style={{ color: currentColor, fontWeight: bold ? "bold" : "normal" }}>
          {chunk}
        </span>
      );
    }
    const codes = match[1].split(";");
    for (const code of codes) {
      if (code === "0" || code === "") {
        currentColor = undefined;
        bold = false;
      } else if (code === "1") {
        bold = true;
      } else if (ANSI_COLORS[code]) {
        currentColor = ANSI_COLORS[code];
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={parts.length} style={{ color: currentColor, fontWeight: bold ? "bold" : "normal" }}>
        {text.slice(lastIndex)}
      </span>
    );
  }

  return parts;
}

registerComponent("Terminal", ({ props }) => (
  <pre
    style={{
      margin: "8px 0",
      padding: 12,
      background: "#1a1a1a",
      color: "#ccc",
      borderRadius: 4,
      fontFamily: "var(--vscode-editor-font-family, monospace)",
      fontSize: 13,
      lineHeight: 1.4,
      overflow: "auto",
      whiteSpace: "pre-wrap",
    }}
  >
    {props.prompt != null && (
      <span style={{ color: "#0dbc79" }}>{String(props.prompt)} </span>
    )}
    {parseAnsi(String(props.content ?? ""))}
  </pre>
));

// --- RenderComponent ---

function RenderComponent({
  component,
  onAction,
  dataModel,
  loadingComponents,
}: {
  component: ComponentDef;
  onAction: ActionHandler;
  dataModel: Record<string, unknown>;
  loadingComponents?: Set<string>;
}) {
  const resolvedProps = resolveProps(component.props, dataModel);
  const Renderer = componentRegistry.get(component.type);

  if (!Renderer) {
    return (
      <div style={{ opacity: 0.5, fontStyle: "italic", margin: "4px 0" }}>
        [{component.type}: not yet implemented]
      </div>
    );
  }

  return (
    <Renderer
      id={component.id}
      props={resolvedProps}
      children={component.children}
      onAction={onAction}
      dataModel={dataModel}
      loading={loadingComponents?.has(component.id)}
    />
  );
}

// --- App ---

interface ActionFeedback {
  componentId: string;
  status: "success" | "error";
  message?: string;
}

function App() {
  const [surfaces, setSurfaces] = React.useState<Map<string, Surface>>(
    new Map()
  );
  const [loadingComponents, setLoadingComponents] = React.useState<Set<string>>(
    new Set()
  );
  const [feedbacks, setFeedbacks] = React.useState<Map<string, ActionFeedback>>(
    new Map()
  );

  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;

      // Handle action result feedback from extension
      if (msg.type === "actionResult") {
        const componentId = msg.componentId as string;
        setLoadingComponents((prev) => {
          const next = new Set(prev);
          next.delete(componentId);
          return next;
        });
        if (msg.status === "success" || msg.status === "error") {
          setFeedbacks((prev) => {
            const next = new Map(prev);
            next.set(componentId, {
              componentId,
              status: msg.status as "success" | "error",
              message: msg.message as string | undefined,
            });
            return next;
          });
          // Auto-clear feedback after 3s
          setTimeout(() => {
            setFeedbacks((prev) => {
              const next = new Map(prev);
              next.delete(componentId);
              return next;
            });
          }, 3000);
        }
        return;
      }

      if (msg.type !== "a2ui") return;

      const a2ui = msg.payload;
      switch (a2ui.type) {
        case "createSurface":
          setSurfaces((prev) => {
            const next = new Map(prev);
            next.set(a2ui.surface.id, {
              id: a2ui.surface.id,
              title: a2ui.surface.title,
              components: a2ui.components ?? [],
              dataModel: a2ui.dataModel ?? {},
            });
            return next;
          });
          break;

        case "updateComponents":
          setSurfaces((prev) => {
            const next = new Map(prev);
            const surface = next.get(a2ui.surfaceId);
            if (surface) {
              next.set(a2ui.surfaceId, {
                ...surface,
                components: a2ui.components,
              });
            }
            return next;
          });
          break;

        case "updateDataModel":
          setSurfaces((prev) => {
            const next = new Map(prev);
            const surface = next.get(a2ui.surfaceId);
            if (surface) {
              let newDataModel = { ...surface.dataModel };
              // Support flat merge via `data` field
              if (a2ui.data && typeof a2ui.data === "object") {
                newDataModel = { ...newDataModel, ...a2ui.data };
              }
              // Support deep pointer updates via `patches` field
              if (Array.isArray(a2ui.patches)) {
                for (const patch of a2ui.patches as Array<{ pointer: string; value: unknown }>) {
                  if (patch.pointer) {
                    newDataModel = setByPointer(newDataModel, patch.pointer, patch.value);
                  }
                }
              }
              next.set(a2ui.surfaceId, { ...surface, dataModel: newDataModel });
            }
            return next;
          });
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleAction = (action: string, context: Record<string, unknown>) => {
    const componentId = context.componentId as string | undefined;
    if (componentId) {
      setLoadingComponents((prev) => new Set(prev).add(componentId));
    }
    vscode.postMessage({ type: "userAction", action, context });
  };

  return (
    <div
      style={{
        padding: 16,
        color: "var(--vscode-foreground, #ccc)",
        fontFamily: "var(--vscode-font-family, sans-serif)",
        fontSize: "var(--vscode-font-size, 13px)",
      }}
    >
      {surfaces.size === 0 && (
        <p style={{ opacity: 0.5, textAlign: "center", marginTop: 32 }}>
          Waiting for Canvas content...
        </p>
      )}
      {Array.from(surfaces.values()).map((surface) => (
        <div key={surface.id} style={{ marginBottom: 16 }}>
          {surface.title && (
            <h2 style={{ margin: "0 0 12px 0", fontSize: 16 }}>
              {surface.title}
            </h2>
          )}
          {surface.components.map((comp) => (
            <div key={comp.id}>
              <RenderComponent
                component={comp}
                onAction={handleAction}
                dataModel={surface.dataModel ?? {}}
                loadingComponents={loadingComponents}
              />
              {feedbacks.has(comp.id) && (
                <div
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    marginTop: 2,
                    color: feedbacks.get(comp.id)!.status === "error"
                      ? "var(--vscode-errorForeground, #f44)"
                      : "var(--vscode-testing-iconPassed, #4caf50)",
                  }}
                >
                  {feedbacks.get(comp.id)!.message ??
                    (feedbacks.get(comp.id)!.status === "error" ? "Action failed" : "Done")}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
