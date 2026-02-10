/**
 * A2UI Component Registry tests.
 *
 * The registry manages registration and lookup of A2UI components.
 * These tests validate the expected registry contract.
 * Will be updated once src/a2ui/registry.ts is implemented (Task #5).
 */
import { describe, it, expect, vi } from "vitest";

/** Expected component descriptor interface */
interface ComponentDescriptor {
  type: string;
  render: (props: Record<string, unknown>) => unknown;
  version?: string;
}

/** Expected registry interface */
interface ComponentRegistry {
  register(descriptor: ComponentDescriptor): void;
  get(type: string): ComponentDescriptor | undefined;
  has(type: string): boolean;
  list(): string[];
  unregister(type: string): boolean;
}

/**
 * Minimal registry implementation for testing the expected contract.
 * Will be replaced by the actual import once Task #5 is done.
 */
class SimpleComponentRegistry implements ComponentRegistry {
  private components = new Map<string, ComponentDescriptor>();

  register(descriptor: ComponentDescriptor): void {
    if (!descriptor.type) {
      throw new Error("Component type is required");
    }
    if (this.components.has(descriptor.type)) {
      throw new Error(`Component '${descriptor.type}' is already registered`);
    }
    this.components.set(descriptor.type, descriptor);
  }

  get(type: string): ComponentDescriptor | undefined {
    return this.components.get(type);
  }

  has(type: string): boolean {
    return this.components.has(type);
  }

  list(): string[] {
    return Array.from(this.components.keys());
  }

  unregister(type: string): boolean {
    return this.components.delete(type);
  }
}

describe("A2UI ComponentRegistry", () => {
  function createRegistry(): ComponentRegistry {
    return new SimpleComponentRegistry();
  }

  describe("register", () => {
    it("should register a component", () => {
      const registry = createRegistry();
      const render = vi.fn();
      registry.register({ type: "text-block", render });

      expect(registry.has("text-block")).toBe(true);
    });

    it("should throw if type is empty", () => {
      const registry = createRegistry();
      expect(() => {
        registry.register({ type: "", render: vi.fn() });
      }).toThrow("type is required");
    });

    it("should throw if component is already registered", () => {
      const registry = createRegistry();
      registry.register({ type: "button", render: vi.fn() });

      expect(() => {
        registry.register({ type: "button", render: vi.fn() });
      }).toThrow("already registered");
    });
  });

  describe("get", () => {
    it("should return the registered component", () => {
      const registry = createRegistry();
      const render = vi.fn();
      registry.register({ type: "card", render, version: "1.0" });

      const component = registry.get("card");
      expect(component).toBeDefined();
      expect(component!.type).toBe("card");
      expect(component!.render).toBe(render);
      expect(component!.version).toBe("1.0");
    });

    it("should return undefined for unregistered types", () => {
      const registry = createRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("has", () => {
    it("should return true for registered components", () => {
      const registry = createRegistry();
      registry.register({ type: "input", render: vi.fn() });
      expect(registry.has("input")).toBe(true);
    });

    it("should return false for unregistered components", () => {
      const registry = createRegistry();
      expect(registry.has("missing")).toBe(false);
    });
  });

  describe("list", () => {
    it("should return empty array when no components registered", () => {
      const registry = createRegistry();
      expect(registry.list()).toEqual([]);
    });

    it("should return all registered component types", () => {
      const registry = createRegistry();
      registry.register({ type: "text", render: vi.fn() });
      registry.register({ type: "image", render: vi.fn() });
      registry.register({ type: "button", render: vi.fn() });

      const types = registry.list();
      expect(types).toHaveLength(3);
      expect(types).toContain("text");
      expect(types).toContain("image");
      expect(types).toContain("button");
    });
  });

  describe("unregister", () => {
    it("should remove a registered component", () => {
      const registry = createRegistry();
      registry.register({ type: "widget", render: vi.fn() });
      expect(registry.has("widget")).toBe(true);

      const removed = registry.unregister("widget");
      expect(removed).toBe(true);
      expect(registry.has("widget")).toBe(false);
    });

    it("should return false when unregistering a non-existent component", () => {
      const registry = createRegistry();
      expect(registry.unregister("nope")).toBe(false);
    });

    it("should allow re-registration after unregister", () => {
      const registry = createRegistry();
      const render1 = vi.fn();
      const render2 = vi.fn();

      registry.register({ type: "panel", render: render1 });
      registry.unregister("panel");
      registry.register({ type: "panel", render: render2 });

      expect(registry.get("panel")!.render).toBe(render2);
    });
  });
});
