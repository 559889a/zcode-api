import { describe, expect, test } from "bun:test";
import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";
import type { PoolEntry } from "../pool/pool.js";
import { startAutoClaim } from "./runtime.js";

/**
 * startAutoClaim fans one scheduler out per jwt-bearing pool account and
 * routes that account's claim-plane fetch through its own exit proxy. These
 * tests drive the REAL ClaimScheduler timers (small pollIntervalMs) against
 * a stub pool + fetch; no captcha is involved (idle previews only).
 */

const config = {
  claim: { origin: "https://claim.test", planId: "", pollIntervalMs: 40, cooldownMs: 40 },
  identity: { appVersion: "3.12.3", deviceMid: "0f0e0d0c-0000-4000-8000-000000000001" },
} as unknown as ProxyConfig;

function entry(i: number, withJwt: boolean, proxyUrl?: string): PoolEntry {
  return {
    id: `oauth:zai:key${i}`,
    label: `zai-oauth${i}`,
    provider: "zai",
    source: "oauth",
    plan: "start-plan",
    credential: {
      apiKey: `key${i}`,
      provider: "zai",
      ...(withJwt ? { jwt: `jwt-${i}` } : {}),
    },
    ...(proxyUrl ? { proxyUrl } : {}),
  } as PoolEntry;
}

interface RecordedCall {
  auth: string;
  proxy?: string;
}

function recorder(): { calls: RecordedCall[]; fetchStub: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchStub = ((_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ auth: headers.Authorization ?? "", proxy: (init as { proxy?: string } | undefined)?.proxy });
    return Promise.resolve(
      new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 }),
    );
  }) as unknown as typeof fetch;
  return { calls, fetchStub };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stubAuth(getEntries: () => PoolEntry[]): AuthManager {
  return { getPool: () => ({ snapshotEntries: getEntries }) } as unknown as AuthManager;
}

describe("startAutoClaim per-account fan", () => {
  test("one scheduler per jwt account; claim fetch follows that account's exit proxy", async () => {
    const entries = [
      entry(1, true, "http://127.0.0.1:47001"),
      entry(2, true, "http://127.0.0.1:47002"),
      entry(3, false), // config-style key: no jwt, must never poll
    ];
    const { calls, fetchStub } = recorder();
    const fan = startAutoClaim(config, stubAuth(() => entries), fetchStub);
    try {
      await sleep(150);
      const acc1 = calls.filter((c) => c.auth === "Bearer jwt-1");
      const acc2 = calls.filter((c) => c.auth === "Bearer jwt-2");
      // Startup tick fired immediately for BOTH accounts, then kept polling.
      expect(acc1.length).toBeGreaterThanOrEqual(2);
      expect(acc2.length).toBeGreaterThanOrEqual(2);
      expect(acc1.every((c) => c.proxy === "http://127.0.0.1:47001")).toBe(true);
      expect(acc2.every((c) => c.proxy === "http://127.0.0.1:47002")).toBe(true);
      // No anonymous/jwt-3 traffic: the no-jwt account got no scheduler.
      expect(calls.every((c) => c.auth === "Bearer jwt-1" || c.auth === "Bearer jwt-2")).toBe(true);

      // Proxy binding is read LIVE per request: rebind entry 1 and the next
      // poll for that account must use the new exit.
      entries[0].proxyUrl = "http://127.0.0.1:47077";
      await sleep(150);
      const acc1After = calls.filter((c) => c.auth === "Bearer jwt-1" && c.proxy === "http://127.0.0.1:47077");
      expect(acc1After.length).toBeGreaterThanOrEqual(1);
    } finally {
      fan.stop();
    }
  });

  test("refresh() follows membership: removed account stops polling, added one starts", async () => {
    const entries = [entry(1, true, "http://127.0.0.1:47001"), entry(2, true, "http://127.0.0.1:47002")];
    const { calls, fetchStub } = recorder();
    const fan = startAutoClaim(config, stubAuth(() => entries), fetchStub);
    try {
      await sleep(120);
      // Swap account 2 out, account 9 in (in-place array edit, as
      // setOAuthCredentials rebuilds the list the snapshot returns).
      entries[1] = entry(9, true, "http://127.0.0.1:47009");
      fan.refresh();
      const acc2AtRefresh = calls.filter((c) => c.auth === "Bearer jwt-2").length;
      await sleep(200);
      const acc2After = calls.filter((c) => c.auth === "Bearer jwt-2").length;
      const acc9 = calls.filter((c) => c.auth === "Bearer jwt-9");
      expect(acc9.length).toBeGreaterThanOrEqual(2);
      expect(acc9.every((c) => c.proxy === "http://127.0.0.1:47009")).toBe(true);
      // Removed account: at most one straggler tick already in flight at refresh.
      expect(acc2After - acc2AtRefresh).toBeLessThanOrEqual(1);
      // And stop() halts everything.
      fan.stop();
      const acc1AtStop = calls.filter((c) => c.auth === "Bearer jwt-1").length;
      await sleep(120);
      expect(calls.filter((c) => c.auth === "Bearer jwt-1").length).toBe(acc1AtStop);
    } finally {
      fan.stop();
    }
  });
});
