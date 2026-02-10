/**
 * Tests for the Canvas webview A2UI message handling and component rendering.
 *
 * Since canvas/index.tsx has side effects at module scope (acquireVsCodeApi, createRoot),
 * we test:
 * 1. The A2UI state reducer logic (createSurface, updateComponents, updateDataModel)
 * 2. Data model resolution (resolvePointer, resolveBoundValue)
 *
 * Component rendering is tested separately in the a2ui/registry tests.
 */
import { describe, it, expect } from "vitest";

// --- Replicate core types from canvas/index.tsx ---

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
  dataModel: Record<string, unknown>;
}

// --- Replicate core logic from canvas/index.tsx ---

function resolvePointer(data: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  const parts = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

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

type SurfaceMap = Map<string, Surface>;

/**
 * Mirrors the switch-case logic in the Canvas App's useEffect message handler.
 */
function reduceA2UIMessage(surfaces: SurfaceMap, a2ui: Record<string, unknown>): SurfaceMap {
  const next = new Map(surfaces);

  switch (a2ui.type) {
    case "createSurface": {
      const s = a2ui.surface as { id: string; title?: string };
      next.set(s.id, {
        id: s.id,
        title: s.title,
        components: (a2ui.components as ComponentDef[]) ?? [],
        dataModel: (a2ui.dataModel as Record<string, unknown>) ?? {},
      });
      break;
    }

    case "updateComponents": {
      const surface = next.get(a2ui.surfaceId as string);
      if (surface) {
        next.set(a2ui.surfaceId as string, {
          ...surface,
          components: a2ui.components as ComponentDef[],
        });
      }
      break;
    }

    case "updateDataModel": {
      const surface = next.get(a2ui.surfaceId as string);
      if (surface) {
        let newDataModel = { ...surface.dataModel };
        if (a2ui.data && typeof a2ui.data === "object") {
          newDataModel = { ...newDataModel, ...(a2ui.data as Record<string, unknown>) };
        }
        if (Array.isArray(a2ui.patches)) {
          for (const patch of a2ui.patches as Array<{ pointer: string; value: unknown }>) {
            if (patch.pointer) {
              newDataModel = setByPointer(newDataModel, patch.pointer, patch.value);
            }
          }
        }
        next.set(a2ui.surfaceId as string, { ...surface, dataModel: newDataModel });
      }
      break;
    }
  }

  return next;
}

describe("Canvas webview A2UI handling", () => {
  describe("createSurface", () => {
    it("should create a new surface with components", () => {
      const surfaces = reduceA2UIMessage(new Map(), {
        type: "createSurface",
        surface: { id: "s1", title: "Test Surface" },
        components: [
          { id: "c1", type: "Text", props: { text: "Hello" } },
        ],
      });
      expect(surfaces.size).toBe(1);
      const s = surfaces.get("s1")!;
      expect(s.title).toBe("Test Surface");
      expect(s.components).toHaveLength(1);
      expect(s.components[0].props.text).toBe("Hello");
    });

    it("should create surface with empty components if not provided", () => {
      const surfaces = reduceA2UIMessage(new Map(), {
        type: "createSurface",
        surface: { id: "s1" },
      });
      expect(surfaces.get("s1")!.components).toEqual([]);
    });

    it("should create surface with initial dataModel", () => {
      const surfaces = reduceA2UIMessage(new Map(), {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { count: 0 },
      });
      expect(surfaces.get("s1")!.dataModel).toEqual({ count: 0 });
    });

    it("should allow multiple surfaces", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1", title: "First" },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s2", title: "Second" },
      });
      expect(surfaces.size).toBe(2);
    });

    it("should replace surface if same id", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1", title: "V1" },
        components: [{ id: "c1", type: "Text", props: { text: "old" } }],
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1", title: "V2" },
        components: [{ id: "c2", type: "Button", props: { label: "new" } }],
      });
      expect(surfaces.size).toBe(1);
      expect(surfaces.get("s1")!.title).toBe("V2");
      expect(surfaces.get("s1")!.components[0].type).toBe("Button");
    });
  });

  describe("updateComponents", () => {
    it("should replace components of an existing surface", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        components: [{ id: "c1", type: "Text", props: { text: "old" } }],
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateComponents",
        surfaceId: "s1",
        components: [
          { id: "c2", type: "Button", props: { label: "Click" } },
          { id: "c3", type: "Text", props: { text: "new" } },
        ],
      });
      const s = surfaces.get("s1")!;
      expect(s.components).toHaveLength(2);
      expect(s.components[0].type).toBe("Button");
    });

    it("should not crash if surface does not exist", () => {
      const surfaces = reduceA2UIMessage(new Map(), {
        type: "updateComponents",
        surfaceId: "nonexistent",
        components: [],
      });
      expect(surfaces.size).toBe(0);
    });

    it("should preserve dataModel on component update", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { key: "value" },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateComponents",
        surfaceId: "s1",
        components: [{ id: "c1", type: "Text", props: {} }],
      });
      expect(surfaces.get("s1")!.dataModel).toEqual({ key: "value" });
    });
  });

  describe("updateDataModel", () => {
    it("should merge data into existing dataModel", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { a: 1, b: 2 },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        data: { b: 3, c: 4 },
      });
      expect(surfaces.get("s1")!.dataModel).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("should not crash if surface does not exist", () => {
      const surfaces = reduceA2UIMessage(new Map(), {
        type: "updateDataModel",
        surfaceId: "nonexistent",
        data: { x: 1 },
      });
      expect(surfaces.size).toBe(0);
    });

    it("should preserve components on data model update", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        components: [{ id: "c1", type: "Text", props: { text: "keep" } }],
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        data: { status: "done" },
      });
      expect(surfaces.get("s1")!.components).toHaveLength(1);
      expect(surfaces.get("s1")!.components[0].props.text).toBe("keep");
    });
  });

  describe("resolvePointer", () => {
    it("should resolve simple path", () => {
      expect(resolvePointer({ a: 1 }, "/a")).toBe(1);
    });

    it("should resolve nested path", () => {
      expect(resolvePointer({ a: { b: { c: 42 } } }, "/a/b/c")).toBe(42);
    });

    it("should resolve array index", () => {
      expect(resolvePointer({ items: ["x", "y", "z"] }, "/items/1")).toBe("y");
    });

    it("should return undefined for missing path", () => {
      expect(resolvePointer({ a: 1 }, "/b")).toBeUndefined();
    });

    it("should return undefined for non-pointer string", () => {
      expect(resolvePointer({ a: 1 }, "a")).toBeUndefined();
    });

    it("should handle escaped characters (~0 for ~ and ~1 for /)", () => {
      expect(resolvePointer({ "a/b": { "c~d": 99 } }, "/a~1b/c~0d")).toBe(99);
    });

    it("should return undefined for null intermediate", () => {
      expect(resolvePointer({ a: null }, "/a/b")).toBeUndefined();
    });
  });

  describe("resolveBoundValue", () => {
    it("should resolve $ref to data model value", () => {
      const dm = { status: "active" };
      expect(resolveBoundValue({ $ref: "/status" }, dm)).toBe("active");
    });

    it("should pass through non-ref values", () => {
      expect(resolveBoundValue("plain", {})).toBe("plain");
      expect(resolveBoundValue(42, {})).toBe(42);
      expect(resolveBoundValue(null, {})).toBeNull();
    });

    it("should pass through objects without $ref", () => {
      const obj = { key: "value" };
      expect(resolveBoundValue(obj, {})).toBe(obj);
    });
  });

  describe("resolveProps", () => {
    it("should resolve all $ref props against data model", () => {
      const dm = { title: "Hello", count: 5 };
      const props = {
        text: { $ref: "/title" },
        number: { $ref: "/count" },
        plain: "static",
      };
      const resolved = resolveProps(props, dm);
      expect(resolved.text).toBe("Hello");
      expect(resolved.number).toBe(5);
      expect(resolved.plain).toBe("static");
    });

    it("should return undefined for unresolvable refs", () => {
      const resolved = resolveProps({ text: { $ref: "/missing" } }, {});
      expect(resolved.text).toBeUndefined();
    });
  });

  describe("setByPointer", () => {
    it("should set a top-level key", () => {
      const result = setByPointer({ a: 1 }, "/b", 2);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should set a nested key", () => {
      const result = setByPointer({ a: { b: 1 } }, "/a/b", 99);
      expect(result).toEqual({ a: { b: 99 } });
    });

    it("should create intermediate objects for missing paths", () => {
      const result = setByPointer({}, "/a/b/c", "deep");
      expect(result).toEqual({ a: { b: { c: "deep" } } });
    });

    it("should clone arrays along the path", () => {
      const original = { items: [1, 2, 3] };
      const result = setByPointer(original, "/items/1", 99);
      expect(result.items).toEqual([1, 99, 3]);
      // Original array should not be mutated
      expect(original.items).toEqual([1, 2, 3]);
    });

    it("should handle escaped characters (~0 and ~1)", () => {
      const result = setByPointer({}, "/a~1b/c~0d", "val");
      expect(result).toEqual({ "a/b": { "c~d": "val" } });
    });

    it("should return data unchanged for non-pointer string", () => {
      const data = { a: 1 };
      expect(setByPointer(data, "noslash", 2)).toBe(data);
    });

    it("should not mutate the original object", () => {
      const original = { a: { b: 1 }, c: 2 };
      const result = setByPointer(original, "/a/b", 99);
      expect(original.a.b).toBe(1);
      expect(result.a).not.toBe(original.a);
      expect((result.a as Record<string, unknown>).b).toBe(99);
    });
  });

  describe("updateDataModel with patches", () => {
    it("should apply a single patch", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { user: { name: "Alice", age: 30 } },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        patches: [{ pointer: "/user/age", value: 31 }],
      });
      const dm = surfaces.get("s1")!.dataModel;
      expect((dm.user as Record<string, unknown>).age).toBe(31);
      expect((dm.user as Record<string, unknown>).name).toBe("Alice");
    });

    it("should apply multiple patches in order", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { a: 1, b: 2 },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        patches: [
          { pointer: "/a", value: 10 },
          { pointer: "/c", value: 30 },
        ],
      });
      expect(surfaces.get("s1")!.dataModel).toEqual({ a: 10, b: 2, c: 30 });
    });

    it("should combine data merge and patches", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { x: 1, nested: { y: 2 } },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        data: { x: 10, z: 30 },
        patches: [{ pointer: "/nested/y", value: 99 }],
      });
      const dm = surfaces.get("s1")!.dataModel;
      expect(dm.x).toBe(10);
      expect(dm.z).toBe(30);
      expect((dm.nested as Record<string, unknown>).y).toBe(99);
    });

    it("should skip patches with empty pointer", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: { a: 1 },
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        patches: [
          { pointer: "", value: "bad" },
          { pointer: "/a", value: 2 },
        ],
      });
      expect(surfaces.get("s1")!.dataModel).toEqual({ a: 2 });
    });

    it("should create deep paths that don't exist yet", () => {
      let surfaces: SurfaceMap = new Map();
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1" },
        dataModel: {},
      });
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        patches: [{ pointer: "/deeply/nested/value", value: 42 }],
      });
      const dm = surfaces.get("s1")!.dataModel;
      expect(
        ((dm.deeply as Record<string, unknown>).nested as Record<string, unknown>).value
      ).toBe(42);
    });
  });

  describe("full A2UI lifecycle", () => {
    it("should handle create → update components → update data → resolve", () => {
      let surfaces: SurfaceMap = new Map();

      // Create surface with data-bound component
      surfaces = reduceA2UIMessage(surfaces, {
        type: "createSurface",
        surface: { id: "s1", title: "Dashboard" },
        components: [
          { id: "c1", type: "Text", props: { text: { $ref: "/status" } } },
        ],
        dataModel: { status: "loading" },
      });

      const s1 = surfaces.get("s1")!;
      const resolved1 = resolveProps(s1.components[0].props, s1.dataModel);
      expect(resolved1.text).toBe("loading");

      // Update data model
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateDataModel",
        surfaceId: "s1",
        data: { status: "ready", items: [1, 2, 3] },
      });

      const s2 = surfaces.get("s1")!;
      const resolved2 = resolveProps(s2.components[0].props, s2.dataModel);
      expect(resolved2.text).toBe("ready");

      // Update components
      surfaces = reduceA2UIMessage(surfaces, {
        type: "updateComponents",
        surfaceId: "s1",
        components: [
          { id: "c1", type: "Text", props: { text: { $ref: "/status" } } },
          { id: "c2", type: "Text", props: { text: { $ref: "/items/0" } } },
        ],
      });

      const s3 = surfaces.get("s1")!;
      expect(s3.components).toHaveLength(2);
      const resolved3 = resolveProps(s3.components[1].props, s3.dataModel);
      expect(resolved3.text).toBe(1);
    });
  });
});
