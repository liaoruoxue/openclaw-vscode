/**
 * A2UI Data Model tests.
 *
 * The A2UI data model manages reactive state for surfaces using JSON Pointer
 * based data binding. These tests validate the data model module once it's
 * implemented in src/a2ui/dataModel.ts (part of Task #5).
 *
 * For now, we test the expected behavior based on the A2UIMessage types
 * defined in src/gateway/types.ts.
 */
import { describe, it, expect, vi } from "vitest";

// The A2UI data model doesn't exist yet (Task #5). We define the expected
// interface here and will update imports once the module is created.

/** Expected interface for the data model */
interface DataModel {
  get(pointer: string): unknown;
  set(pointer: string, value: unknown): void;
  subscribe(pointer: string, callback: (value: unknown) => void): { dispose(): void };
  toJSON(): Record<string, unknown>;
  applyPatch(patch: Record<string, unknown>): void;
}

/**
 * Minimal implementation for testing the expected contract.
 * This will be replaced by the actual import once Task #5 is done.
 */
class SimpleDataModel implements DataModel {
  private data: Record<string, unknown> = {};
  private subscribers = new Map<string, Set<(value: unknown) => void>>();

  get(pointer: string): unknown {
    const parts = pointer.replace(/^\//, "").split("/");
    let current: unknown = this.data;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  set(pointer: string, value: unknown): void {
    const parts = pointer.replace(/^\//, "").split("/");
    const last = parts.pop()!;
    let current: Record<string, unknown> = this.data;
    for (const part of parts) {
      if (!(part in current) || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[last] = value;
    this.notifySubscribers(pointer, value);
  }

  subscribe(
    pointer: string,
    callback: (value: unknown) => void
  ): { dispose(): void } {
    if (!this.subscribers.has(pointer)) {
      this.subscribers.set(pointer, new Set());
    }
    this.subscribers.get(pointer)!.add(callback);
    return {
      dispose: () => {
        this.subscribers.get(pointer)?.delete(callback);
      },
    };
  }

  toJSON(): Record<string, unknown> {
    return structuredClone(this.data);
  }

  applyPatch(patch: Record<string, unknown>): void {
    for (const [pointer, value] of Object.entries(patch)) {
      this.set(pointer, value);
    }
  }

  private notifySubscribers(pointer: string, value: unknown): void {
    const subs = this.subscribers.get(pointer);
    if (subs) {
      for (const cb of subs) {
        cb(value);
      }
    }
  }
}

describe("A2UI DataModel", () => {
  describe("JSON Pointer get/set", () => {
    it("should set and get a top-level value", () => {
      const model = new SimpleDataModel();
      model.set("/title", "Hello");
      expect(model.get("/title")).toBe("Hello");
    });

    it("should set and get nested values", () => {
      const model = new SimpleDataModel();
      model.set("/user/name", "Alice");
      model.set("/user/age", 30);

      expect(model.get("/user/name")).toBe("Alice");
      expect(model.get("/user/age")).toBe(30);
    });

    it("should return undefined for non-existent paths", () => {
      const model = new SimpleDataModel();
      expect(model.get("/nonexistent")).toBeUndefined();
      expect(model.get("/a/b/c")).toBeUndefined();
    });

    it("should overwrite existing values", () => {
      const model = new SimpleDataModel();
      model.set("/count", 1);
      model.set("/count", 2);
      expect(model.get("/count")).toBe(2);
    });

    it("should support complex values (objects, arrays)", () => {
      const model = new SimpleDataModel();
      model.set("/items", [1, 2, 3]);
      expect(model.get("/items")).toEqual([1, 2, 3]);

      model.set("/config", { theme: "dark", lang: "en" });
      expect(model.get("/config")).toEqual({ theme: "dark", lang: "en" });
    });
  });

  describe("subscriptions", () => {
    it("should notify subscribers when a value changes", () => {
      const model = new SimpleDataModel();
      const callback = vi.fn();
      model.subscribe("/status", callback);

      model.set("/status", "loading");
      expect(callback).toHaveBeenCalledWith("loading");

      model.set("/status", "done");
      expect(callback).toHaveBeenCalledWith("done");
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should not notify after dispose", () => {
      const model = new SimpleDataModel();
      const callback = vi.fn();
      const sub = model.subscribe("/value", callback);

      model.set("/value", "first");
      sub.dispose();
      model.set("/value", "second");

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should support multiple subscribers for the same pointer", () => {
      const model = new SimpleDataModel();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      model.subscribe("/x", cb1);
      model.subscribe("/x", cb2);

      model.set("/x", 42);

      expect(cb1).toHaveBeenCalledWith(42);
      expect(cb2).toHaveBeenCalledWith(42);
    });

    it("should not notify subscribers for different pointers", () => {
      const model = new SimpleDataModel();
      const cb = vi.fn();
      model.subscribe("/a", cb);

      model.set("/b", "value");
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("toJSON", () => {
    it("should return a deep clone of the data", () => {
      const model = new SimpleDataModel();
      model.set("/x", 1);
      model.set("/y/z", 2);

      const json = model.toJSON();
      expect(json).toEqual({ x: 1, y: { z: 2 } });

      // Verify it's a clone, not a reference
      json.x = 999;
      expect(model.get("/x")).toBe(1);
    });
  });

  describe("applyPatch", () => {
    it("should apply multiple pointer-value pairs at once", () => {
      const model = new SimpleDataModel();
      model.applyPatch({
        "/name": "Bob",
        "/role": "admin",
        "/settings/theme": "dark",
      });

      expect(model.get("/name")).toBe("Bob");
      expect(model.get("/role")).toBe("admin");
      expect(model.get("/settings/theme")).toBe("dark");
    });

    it("should notify subscribers for each changed pointer", () => {
      const model = new SimpleDataModel();
      const nameCb = vi.fn();
      const roleCb = vi.fn();
      model.subscribe("/name", nameCb);
      model.subscribe("/role", roleCb);

      model.applyPatch({
        "/name": "Alice",
        "/role": "editor",
      });

      expect(nameCb).toHaveBeenCalledWith("Alice");
      expect(roleCb).toHaveBeenCalledWith("editor");
    });
  });
});
