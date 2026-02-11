/**
 * Convert freeform A2UI JSONL (from agent) into proper v0.8 messages
 * that @a2ui/lit can render via its signalA2uiMessageProcessor.
 *
 * v0.8 message format:
 *   {surfaceUpdate: {surfaceId, components: [{id, component: {Type: {prop: wrappedValue}}}]}}
 *   {beginRendering: {surfaceId, root: "rootId"}}
 *   {dataModelUpdate: {surfaceId, data|patches}}
 *   {deleteSurface: {surfaceId}}
 *
 * v0.8 value wrapping:
 *   string  → {literalString: "..."}
 *   number  → {literalNumber: N}
 *   boolean → {literalBoolean: B}
 *   array   → not directly wrapped — use explicitList for children refs
 *
 * The agent often sends freeform JSONL like:
 *   {"type":"table","columns":["A","B"],"rows":[["1","2"]]}
 *   {"type":"createSurface","id":"x","content":{"type":"Table",...}}
 *   {"surfaceUpdate":...}  (already v0.8)
 */

// Optional logger — avoid hard dependency on vscode for testability
let _log: (msg: string) => void = () => {};
export function setA2UILogger(fn: (msg: string) => void): void {
  _log = fn;
}

// ---- v0.8 action keys ----
const V08_ACTION_KEYS = ["surfaceUpdate", "beginRendering", "dataModelUpdate", "deleteSurface"] as const;

/** Check if a parsed JSON object is already a valid v0.8 message */
function isV08Message(obj: Record<string, unknown>): boolean {
  return V08_ACTION_KEYS.some((key) => key in obj);
}

// ---- v0.8 value wrappers ----

function wrapValue(val: unknown): unknown {
  if (val === null || val === undefined) return { literalString: "" };
  if (typeof val === "string") return { literalString: val };
  if (typeof val === "number") return { literalNumber: val };
  if (typeof val === "boolean") return { literalBoolean: val };
  // Complex objects pass through as-is (for nested component props)
  return val;
}

// ---- Component ID generation ----

let idCounter = 0;
function nextId(prefix = "c"): string {
  return `${prefix}_${++idCounter}`;
}

/** Reset counter between conversions */
function resetIdCounter(): void {
  idCounter = 0;
}

// ---- Build v0.8 component ----

interface V08Component {
  id: string;
  component: Record<string, Record<string, unknown>>;
}

function makeV08Component(
  id: string,
  typeName: string,
  props: Record<string, unknown>,
  childIds?: string[],
): V08Component {
  const wrappedProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(props)) {
    if (key === "type" || key === "id" || key === "children") continue;
    wrappedProps[key] = wrapValue(val);
  }
  if (childIds && childIds.length > 0) {
    wrappedProps.children = { explicitList: childIds };
  }
  return {
    id,
    component: { [typeName]: wrappedProps },
  };
}

// ---- Freeform → v0.8 component extraction ----

/** Extract a flat list of v0.8 components from a freeform component tree */
function extractComponents(
  raw: Record<string, unknown>,
  assignedId?: string,
): { components: V08Component[]; rootId: string } {
  const components: V08Component[] = [];
  const id = assignedId ?? (raw.id as string) ?? nextId();
  const rawType = typeof raw.type === "string" ? raw.type : "Text";
  const typeName = rawType.charAt(0).toUpperCase() + rawType.slice(1);

  // Process children recursively
  const rawChildren = raw.children as unknown[] | undefined;
  const childIds: string[] = [];
  if (Array.isArray(rawChildren)) {
    for (const child of rawChildren) {
      if (child && typeof child === "object" && !Array.isArray(child)) {
        const result = extractComponents(child as Record<string, unknown>);
        components.push(...result.components);
        childIds.push(result.rootId);
      }
    }
  }

  // Map known freeform types to v0.8 equivalents
  const mapped = mapToV08Type(typeName, raw, id, childIds);
  components.push(...mapped.components);

  return { components, rootId: mapped.rootId };
}

/**
 * Map a freeform component to v0.8 component(s).
 * Some freeform types (like Table) need to be decomposed into
 * multiple v0.8 primitives since @a2ui/lit doesn't have them.
 */
function mapToV08Type(
  typeName: string,
  raw: Record<string, unknown>,
  id: string,
  childIds: string[],
): { components: V08Component[]; rootId: string } {
  switch (typeName) {
    case "Table":
      return tableToV08(raw, id);
    case "Progress":
      return progressToV08(raw, id);
    case "Codeblock":
    case "CodeBlock":
      return codeBlockToV08(raw, id);
    default:
      // Pass through as-is (Text, Button, Card, Column, Row, List, Tabs, Modal, Image, etc.)
      return {
        components: [makeV08Component(id, typeName, raw, childIds)],
        rootId: id,
      };
  }
}

/** Convert a freeform Table to v0.8 Column + Text rows */
function tableToV08(
  raw: Record<string, unknown>,
  parentId: string,
): { components: V08Component[]; rootId: string } {
  const components: V08Component[] = [];
  const rowIds: string[] = [];

  // Parse columns
  const rawCols = (raw.columns ?? []) as unknown[];
  const colLabels: string[] = rawCols.map((c) => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      return String(o.label ?? o.title ?? o.header ?? o.name ?? o.key ?? "");
    }
    return String(c);
  });

  // Header row
  if (colLabels.length > 0) {
    const headerId = nextId("hdr");
    const headerText = colLabels.join(" │ ");
    components.push(makeV08Component(headerId, "Text", {
      text: headerText,
      usageHint: "h3",
    }));
    rowIds.push(headerId);

    // Divider
    const divId = nextId("div");
    components.push(makeV08Component(divId, "Divider", {}));
    rowIds.push(divId);
  }

  // Data rows
  const rawRows = (raw.rows ?? []) as unknown[];
  for (const row of rawRows) {
    const rowId = nextId("row");
    let cellTexts: string[];
    if (Array.isArray(row)) {
      cellTexts = row.map((v) => String(v ?? ""));
    } else if (row && typeof row === "object") {
      const obj = row as Record<string, unknown>;
      // Use column keys to extract in order, or just values
      if (rawCols.length > 0 && typeof rawCols[0] === "object") {
        const colKeys = rawCols.map((c) => String((c as Record<string, unknown>).key ?? ""));
        cellTexts = colKeys.map((k) => String(obj[k] ?? ""));
      } else {
        cellTexts = Object.values(obj).map((v) => String(v ?? ""));
      }
    } else {
      cellTexts = [String(row)];
    }
    components.push(makeV08Component(rowId, "Text", {
      text: cellTexts.join(" │ "),
      usageHint: "body",
    }));
    rowIds.push(rowId);
  }

  // Wrap in Column
  components.push(makeV08Component(parentId, "Column", {}, rowIds));
  return { components, rootId: parentId };
}

/** Convert Progress to v0.8 Text (since @a2ui/lit has no Progress) */
function progressToV08(
  raw: Record<string, unknown>,
  id: string,
): { components: V08Component[]; rootId: string } {
  const value = Number(raw.value ?? 0);
  const max = Number(raw.max ?? 100);
  const pct = Math.min(100, Math.max(0, Math.round((value / max) * 100)));
  const label = raw.label ? String(raw.label) : `${pct}%`;
  const barFilled = Math.round(pct / 5);
  const bar = "█".repeat(barFilled) + "░".repeat(20 - barFilled);
  return {
    components: [makeV08Component(id, "Text", { text: `${label}\n${bar}`, usageHint: "body" })],
    rootId: id,
  };
}

/** Convert CodeBlock to v0.8 Text with pre formatting */
function codeBlockToV08(
  raw: Record<string, unknown>,
  id: string,
): { components: V08Component[]; rootId: string } {
  const code = String(raw.code ?? raw.content ?? raw.text ?? "");
  const lang = raw.language ?? raw.lang ?? "";
  const filename = raw.filename ?? "";
  const label = filename ? `${filename}` : lang ? `[${lang}]` : "";
  const text = label ? `${label}\n${code}` : code;
  return {
    components: [makeV08Component(id, "Text", { text, usageHint: "body" })],
    rootId: id,
  };
}

// ---- Main conversion ----

/** Convert a single freeform message to v0.8 messages */
function convertOneMessage(raw: Record<string, unknown>): Record<string, unknown>[] {
  // Already v0.8 — pass through
  if (isV08Message(raw)) {
    return [raw];
  }

  // v0.9 createSurface — extract components and convert
  if (raw.type === "createSurface" || raw.createSurface) {
    const cs = raw.createSurface
      ? (raw.createSurface as Record<string, unknown>)
      : raw;

    const surfaceId = String(cs.id ?? (cs.surface as Record<string, unknown>)?.id ?? cs.surfaceId ?? "main");

    // Try to find components from various field names
    let rawComponents: unknown[] = [];
    if (cs.surface && Array.isArray((cs as Record<string, unknown>).components)) {
      // Our internal format: {type: "createSurface", surface: {id}, components: [...]}
      rawComponents = (cs as Record<string, unknown>).components as unknown[];
    } else if (Array.isArray(cs.components)) {
      rawComponents = cs.components as unknown[];
    } else {
      // Single component in various field names
      const single = (cs.component ?? cs.content ?? cs.body ?? cs.ui) as Record<string, unknown> | undefined;
      if (single && typeof single === "object") {
        rawComponents = [single];
      }
    }

    if (rawComponents.length === 0) {
      return [];
    }

    // Convert each component to v0.8 format
    const allComponents: V08Component[] = [];
    const topLevelIds: string[] = [];
    for (const comp of rawComponents) {
      if (!comp || typeof comp !== "object") continue;
      const c = comp as Record<string, unknown>;
      const result = extractComponents(c);
      allComponents.push(...result.components);
      topLevelIds.push(result.rootId);
    }

    // Wrap in a root Column if multiple top-level components
    let rootId: string;
    if (topLevelIds.length === 1) {
      rootId = topLevelIds[0];
    } else {
      rootId = nextId("root");
      allComponents.push(makeV08Component(rootId, "Column", {}, topLevelIds));
    }

    return [
      { surfaceUpdate: { surfaceId, components: allComponents } },
      { beginRendering: { surfaceId, root: rootId } },
    ];
  }

  // Bare component (e.g. {type: "table", columns: [...], rows: [...]})
  if (typeof raw.type === "string" && raw.type !== "event" && raw.type !== "res" && raw.type !== "req") {
    const surfaceId = "main";
    const result = extractComponents(raw);
    const rootId = nextId("root");
    const allComponents = [
      ...result.components,
      makeV08Component(rootId, "Column", {}, [result.rootId]),
    ];
    return [
      { surfaceUpdate: { surfaceId, components: allComponents } },
      { beginRendering: { surfaceId, root: rootId } },
    ];
  }

  // Unknown format — skip
  _log(`[a2uiV08] Skipping unknown message format, keys=${Object.keys(raw).join(",")}`);
  return [];
}

/**
 * Convert raw JSONL string (from agent) to v0.8 messages array.
 * Returns an array of v0.8 message objects ready for @a2ui/lit's processMessages().
 */
export function convertJsonlToV08(jsonl: string): Record<string, unknown>[] {
  resetIdCounter();
  const lines = jsonl.split("\n").filter((l) => l.trim());
  const parsed: Record<string, unknown>[] = [];

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      _log(`[a2uiV08] Failed to parse JSONL line: ${line.slice(0, 200)}`);
    }
  }

  if (parsed.length === 0) return [];

  // Check if ALL lines are already v0.8
  const allV08 = parsed.every(isV08Message);
  if (allV08) {
    return parsed;
  }

  // Check if these are structured messages (createSurface, surfaceUpdate, etc.)
  const hasStructured = parsed.some(
    (m) => isV08Message(m) || m.type === "createSurface" || m.createSurface,
  );

  if (hasStructured) {
    // Process each message individually
    const result: Record<string, unknown>[] = [];
    for (const msg of parsed) {
      result.push(...convertOneMessage(msg));
    }
    return result;
  }

  // All bare components — batch into a single surface
  const allComponents: V08Component[] = [];
  const topLevelIds: string[] = [];
  let title = "Canvas";

  for (const msg of parsed) {
    const rawType = typeof msg.type === "string" ? msg.type : "";
    // Skip page/header/title meta-messages
    if (rawType === "page" || rawType === "header" || rawType === "title") {
      title = String(msg.title ?? msg.text ?? msg.label ?? title);
      continue;
    }
    const result = extractComponents(msg);
    allComponents.push(...result.components);
    topLevelIds.push(result.rootId);
  }

  if (topLevelIds.length === 0) return [];

  // Title component
  const titleId = nextId("title");
  allComponents.push(makeV08Component(titleId, "Text", { text: title, usageHint: "h1" }));

  // Root column
  const rootId = nextId("root");
  allComponents.push(makeV08Component(rootId, "Column", {}, [titleId, ...topLevelIds]));

  return [
    { surfaceUpdate: { surfaceId: "main", components: allComponents } },
    { beginRendering: { surfaceId: "main", root: rootId } },
  ];
}

/**
 * Convert a2ui.push messages array to v0.8 format.
 * Messages are already parsed objects (not JSONL).
 */
export function convertMessagesToV08(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  resetIdCounter();
  const result: Record<string, unknown>[] = [];
  for (const msg of messages) {
    result.push(...convertOneMessage(msg));
  }
  return result;
}
