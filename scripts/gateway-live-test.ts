#!/usr/bin/env npx tsx
/**
 * Gateway Live Test
 *
 * Tests all WebSocket interfaces against a running OpenClaw Gateway.
 * Usage: npx tsx scripts/gateway-live-test.ts <ws-url> <token>
 * Example: npx tsx scripts/gateway-live-test.ts ws://1.2.3.4:18789 abc123
 *
 * On first run, generates Ed25519 device keys and saves to .gateway-test-keys.json
 * You may need to approve the device: clawdbot devices approve
 */
import WebSocket from "ws";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { fileURLToPath } from "url";

// ── Config ──────────────────────────────────────────────────────────────

const GATEWAY_URL = process.argv[2];
const TOKEN = process.argv[3];

if (!GATEWAY_URL || !TOKEN) {
  console.error("Usage: npx tsx scripts/gateway-live-test.ts <ws-url> <token>");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, ".gateway-test-keys.json");
const TIMEOUT_MS = 15_000;

// ── Helpers ─────────────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

interface DeviceKeys {
  publicKey: string; // hex raw 32 bytes
  privateKey: string; // hex DER PKCS8
}

function loadOrCreateKeys(): DeviceKeys {
  if (fs.existsSync(KEYS_FILE)) {
    const data = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
    console.log("  Loaded existing device keys from", KEYS_FILE);
    return data as DeviceKeys;
  }
  const pair = crypto.generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const publicKey = spki.subarray(-32).toString("hex");
  const privateKey = (pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("hex");
  const keys: DeviceKeys = { publicKey, privateKey };
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  const deviceId = crypto.createHash("sha256").update(Buffer.from(publicKey, "hex")).digest("hex");
  console.log("  Generated new device keys, saved to", KEYS_FILE);
  console.log("  Device ID:", deviceId);
  console.log("  ⚠  You may need to approve this device: clawdbot devices approve");
  return keys;
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce?: string;
}): string {
  const version = params.nonce ? "v2" : "v1";
  const parts = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
  ];
  if (version === "v2") {
    parts.push(params.nonce ?? "");
  }
  return parts.join("|");
}

function signDevice(keys: DeviceKeys, nonce: string | undefined, token: string) {
  const signedAtMs = Date.now();
  const deviceId = crypto.createHash("sha256")
    .update(Buffer.from(keys.publicKey, "hex"))
    .digest("hex");
  const payload = buildDeviceAuthPayload({
    deviceId,
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
    signedAtMs,
    token,
    nonce,
  });
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(keys.privateKey, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyObj);
  return {
    id: deviceId,
    publicKey: base64UrlEncode(Buffer.from(keys.publicKey, "hex")),
    signature: base64UrlEncode(signature),
    signedAt: signedAtMs,
    ...(nonce ? { nonce } : {}),
  };
}

// ── WebSocket wrapper ───────────────────────────────────────────────────

type MsgHandler = (msg: Record<string, unknown>) => void;

class GatewayWS {
  private ws: WebSocket;
  private msgId = 0;
  private handlers: MsgHandler[] = [];
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      // Check pending request resolution
      if (msg.type === "res" && typeof msg.id === "string") {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok === true) {
            p.resolve(msg.payload);
          } else {
            p.reject(new Error(String((msg.error as Record<string, unknown>)?.message ?? msg.error ?? "request failed")));
          }
        }
      }
      for (const h of this.handlers) h(msg);
    });
  }

  onMessage(h: MsgHandler) { this.handlers.push(h); }

  send(method: string, params: Record<string, unknown>, id?: string): Promise<unknown> {
    const reqId = id ?? `test_${++this.msgId}`;
    const frame = { type: "req", id: reqId, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.pending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(frame));
    });
  }

  waitForEvent(filter: (msg: Record<string, unknown>) => boolean, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitForEvent timed out")), timeoutMs);
      const h: MsgHandler = (msg) => {
        if (filter(msg)) {
          clearTimeout(timer);
          this.handlers = this.handlers.filter((x) => x !== h);
          resolve(msg);
        }
      };
      this.handlers.push(h);
    });
  }

  close() { this.ws.close(1000); }
}

// ── Connect ─────────────────────────────────────────────────────────────

async function connect(keys: DeviceKeys): Promise<GatewayWS> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    const gw = new GatewayWS(ws);

    ws.on("error", (err) => reject(err));

    gw.onMessage((msg) => {
      // Wait for challenge
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const payload = msg.payload as Record<string, unknown>;
        const nonce = payload.nonce as string;
        const device = signDevice(keys, nonce, TOKEN);

        const connectReq = {
          type: "req",
          id: "connect",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "cli", version: "0.1.0", platform: process.platform, mode: "cli" },
            role: "operator",
            scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
            caps: [],
            commands: [],
            permissions: {},
            auth: { token: TOKEN },
            device,
          },
        };
        ws.send(JSON.stringify(connectReq));
      }

      // Wait for connect response
      if (msg.type === "res" && msg.id === "connect") {
        if (msg.ok === true) {
          resolve(gw);
        } else {
          reject(new Error(`connect failed: ${JSON.stringify(msg.error)}`));
        }
      }
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    passed++;
    console.log("✅");
  } catch (err) {
    failed++;
    console.log("❌", (err as Error).message);
  }
}

async function main() {
  console.log("\n🦞 OpenClaw Gateway Live Test\n");
  console.log("Gateway:", GATEWAY_URL);

  // ── Setup ──
  console.log("\n📦 Device keys:");
  const keys = loadOrCreateKeys();

  console.log("\n🔌 Connecting...");
  let gw: GatewayWS;
  try {
    gw = await connect(keys);
    console.log("  Connected ✅\n");
  } catch (err) {
    console.error("  Connection failed ❌:", (err as Error).message);
    console.error("\n  If 'device identity mismatch' or pending, approve the device on the server.");
    process.exit(1);
  }

  // Collect all events for inspection
  const allEvents: Record<string, unknown>[] = [];
  gw.onMessage((msg) => {
    if (msg.type === "event") {
      allEvents.push(msg);
    }
  });

  console.log("── Tests ──\n");

  // ── Test: chat.send ──
  let chatRunId: string | undefined;
  await test("chat.send returns runId", async () => {
    const sessionKey = `test:live-${Date.now()}`;
    const result = await gw.send("chat.send", {
      sessionKey,
      message: "hi, reply with just the word 'pong'. nothing else.",
      idempotencyKey: crypto.randomUUID(),
    }) as Record<string, unknown>;

    chatRunId = result.runId as string;
    if (!chatRunId) throw new Error(`no runId in response: ${JSON.stringify(result)}`);
  });

  // ── Test: receive chat events ──
  await test("receive chat delta events", async () => {
    const delta = await gw.waitForEvent(
      (m) => m.type === "event" && m.event === "chat" &&
             (m.payload as Record<string, unknown>)?.state === "delta",
      30_000,
    );
    const payload = delta.payload as Record<string, unknown>;
    console.log("\n    📨 delta payload:", JSON.stringify(payload).slice(0, 300));
    if (payload.state !== "delta") throw new Error("expected state=delta");
  });

  await test("receive chat final event", async () => {
    const final = await gw.waitForEvent(
      (m) => m.type === "event" && m.event === "chat" &&
             ((m.payload as Record<string, unknown>)?.state === "final" ||
              (m.payload as Record<string, unknown>)?.state === "error"),
      30_000,
    );
    const payload = final.payload as Record<string, unknown>;
    console.log("\n    📨 final payload:", JSON.stringify(payload).slice(0, 500));
    if (payload.state !== "final" && payload.state !== "error") {
      throw new Error(`expected state=final|error, got ${payload.state}`);
    }
  });

  // ── Test: chat.history ──
  await test("chat.history returns messages", async () => {
    const sessionKey = `test:live-${Date.now()}`;
    const result = await gw.send("chat.history", { sessionKey }) as Record<string, unknown>;
    console.log("\n    📨 history keys:", Object.keys(result));
  });

  // ── Test: chat.abort (on non-running — should not crash) ──
  await test("chat.abort on idle session", async () => {
    try {
      await gw.send("chat.abort", { sessionKey: "test:no-run" });
    } catch {
      // Some gateways reject this — that's ok, we just test it doesn't hang
    }
  });

  // ── Print all events we saw ──
  console.log("\n── All events received ──\n");
  for (const ev of allEvents) {
    const payload = ev.payload as Record<string, unknown>;
    console.log(`  event=${ev.event}  state=${payload?.state ?? "-"}  seq=${payload?.seq ?? "-"}`);
    console.log("    full payload:", JSON.stringify(payload).slice(0, 500));
  }

  // ── Summary ──
  console.log(`\n── Summary: ${passed} passed, ${failed} failed ──\n`);

  gw.close();
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
