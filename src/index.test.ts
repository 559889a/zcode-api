/**
 * Tests for the exported pure functions (`parseServeArgs`,
 * `ensureDeviceMidInConfig`).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseServeArgs, ensureDeviceMidInConfig } from "./index.js";
import { buildIdentityHeaders } from "./proxy/identity.js";

describe("parseServeArgs", () => {
  it("returns debug=false with no args", () => {
    expect(parseServeArgs([])).toEqual({ configPath: undefined, debug: false });
  });

  it("returns debug=true with lone 'debug' token", () => {
    expect(parseServeArgs(["debug"])).toEqual({ configPath: undefined, debug: true });
  });

  it("treats a single non-debug token as the config path", () => {
    expect(parseServeArgs(["my.yaml"])).toEqual({ configPath: "my.yaml", debug: false });
  });

  it("accepts 'debug' before the config path", () => {
    expect(parseServeArgs(["debug", "custom.yaml"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
    });
  });

  it("accepts 'debug' after the config path (order-independent)", () => {
    expect(parseServeArgs(["custom.yaml", "debug"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
    });
  });

  it("is case-sensitive — only lowercase 'debug' toggles the flag", () => {
    expect(parseServeArgs(["DEBUG"])).toEqual({ configPath: "DEBUG", debug: false });
  });
});

const MID_TMP = join(tmpdir(), `zcode-proxy-mid-test-${Date.now()}`);

function writeConfig(content: string): string {
  mkdirSync(MID_TMP, { recursive: true });
  const p = join(MID_TMP, "config.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ensureDeviceMidInConfig", () => {
  afterEach(() => {
    rmSync(MID_TMP, { recursive: true, force: true });
  });

  it("fills an empty deviceMid in place and preserves surrounding comments", () => {
    const p = writeConfig(`identity:
  appVersion: "3.8.1"  # keep me
  deviceMid: ""
other: 1
`);
    const mid = ensureDeviceMidInConfig(p);
    expect(mid).toMatch(UUID_RE);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain("# keep me");
    expect(after).toContain(`deviceMid: "${mid}"`);
    expect(after).toContain("other: 1");
  });

  it("inserts deviceMid under an existing identity: block", () => {
    const p = writeConfig(`identity:
  appVersion: "3.8.1"
`);
    const mid = ensureDeviceMidInConfig(p);
    const after = readFileSync(p, "utf-8");
    expect(after).toContain(`identity:
  deviceMid: "${mid}"
  appVersion: "3.8.1"`);
  });

  it("appends an identity: block when the key is absent entirely", () => {
    const p = writeConfig(`server:
  port: 8080
`);
    const mid = ensureDeviceMidInConfig(p);
    const after = readFileSync(p, "utf-8");
    expect(after.endsWith(`identity:
  deviceMid: "${mid}"
`)).toBeTrue();
  });

  it("is idempotent — an existing mid is returned and the file untouched", () => {
    const existing = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
    const p = writeConfig(`identity:
  deviceMid: "${existing}"
`);
    const before = readFileSync(p, "utf-8");
    expect(ensureDeviceMidInConfig(p)).toBe(existing);
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  it("produces a mid that buildIdentityHeaders emits as X-Device-Mid", () => {
    const p = writeConfig(`identity:
  appVersion: "3.8.1"
`);
    const mid = ensureDeviceMidInConfig(p);
    const h = buildIdentityHeaders({ appVersion: "3.8.1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai", deviceMid: mid });
    expect(h["X-Device-Mid"]).toBe(mid);
  });
});
