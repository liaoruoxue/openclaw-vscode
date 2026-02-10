import { describe, it, expect, vi } from "vitest";
import { createMockVSCode } from "../helpers/mock-vscode";

vi.mock("vscode", () => createMockVSCode());

const { validateGatewayUrl } = await import("../../src/extension");

describe("validateGatewayUrl", () => {
  it("should accept valid ws:// URL", () => {
    expect(validateGatewayUrl("ws://127.0.0.1:18789")).toBeNull();
  });

  it("should accept valid wss:// URL", () => {
    expect(validateGatewayUrl("wss://gateway.example.com")).toBeNull();
  });

  it("should accept ws URL with path", () => {
    expect(validateGatewayUrl("ws://localhost:8080/ws")).toBeNull();
  });

  it("should reject empty URL", () => {
    expect(validateGatewayUrl("")).toContain("empty");
  });

  it("should reject http:// and suggest ws://", () => {
    const err = validateGatewayUrl("http://localhost:8080");
    expect(err).toContain("http://");
    expect(err).toContain("ws://");
  });

  it("should reject https:// and suggest wss://", () => {
    const err = validateGatewayUrl("https://gateway.example.com");
    expect(err).toContain("https://");
    expect(err).toContain("wss://");
  });

  it("should reject URL without ws/wss scheme", () => {
    const err = validateGatewayUrl("localhost:8080");
    expect(err).toContain("ws://");
  });

  it("should reject invalid URL format", () => {
    const err = validateGatewayUrl("ws://[invalid");
    expect(err).toContain("Invalid URL");
  });
});
