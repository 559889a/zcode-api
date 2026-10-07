import { describe, expect, test } from "bun:test";
import type { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { PoolEntry } from "../pool/pool.js";
import { runClaimCli, startAutoClaim } from "./runtime.js";

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
  at: number;
}

function recorder(): { calls: RecordedCall[]; fetchStub: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchStub = ((_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ auth: headers.Authorization ?? "", proxy: (init as { proxy?: string } | undefined)?.proxy, at: Date.now() });
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
    const fan = startAutoClaim(config, stubAuth(() => entries), fetchStub, 0);
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
    const fan = startAutoClaim(config, stubAuth(() => entries), fetchStub, 0);
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

  test("accounts tick staggered, never in the same instant (captcha-solve burst guard)", async () => {
    const entries = [entry(1, true), entry(2, true), entry(3, true)];
    const { calls, fetchStub } = recorder();
    const fan = startAutoClaim(config, stubAuth(() => entries), fetchStub, 250);
    try {
      await sleep(1_200);
      const first = (jwt: string): number | undefined => calls.find((c) => c.auth === `Bearer ${jwt}`)?.at;
      const t1 = first("jwt-1");
      const t2 = first("jwt-2");
      const t3 = first("jwt-3");
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();
      expect(t3).toBeDefined();
      // Index i starts ≈ i×250ms later — no two first ticks land together.
      expect(t2! - t1!).toBeGreaterThanOrEqual(150);
      expect(t3! - t2!).toBeGreaterThanOrEqual(150);
      expect(t3! - t1!).toBeGreaterThanOrEqual(450);
      // Phase drifts a few ms per cycle under setTimeout jitter (acceptable:
      // the guard only needs to break the simultaneous burst; re-alignment
      // after hours merely means two concurrent solves, serialized by the
      // captcha pool lanes anyway) — so no long-window phase assertion here.
    } finally {
      fan.stop();
    }
  });
});

describe("startAutoClaim exit auto-rotation (auto node testing)", () => {
  const DEAD = "http://127.0.0.1:47004"; // pinned, stalls the mint
  const USED = "http://127.0.0.1:47001"; // another account's exit — never a candidate
  const CAND_A = "http://127.0.0.1:47006"; // probe 1: also bad
  const CAND_B = "http://127.0.0.1:47012"; // probe 2: healthy — must win
  const CAND_C = "http://127.0.0.1:47015";
  const TARGETS = [
    { label: "ikuu-01", url: USED },
    { label: "ikuu-05", url: DEAD },
    { label: "ikuu-07", url: CAND_A },
    { label: "ikuu-13", url: CAND_B },
    { label: "ikuu-16", url: CAND_C },
  ];
  const STALL = new Error("captcha child process timeout (20000ms)");
  const PLAN = { plan_id: "egg-1", name: "Egg", description: "", priority: 1, entitlements: [] };

  /**
   * Preview yields the plan only on the FIRST GET for jwt-1 (the rotating
   * account); every other account/account-2 preview is empty so the fan's
   * second scheduler never mints — its exit exists only to test exclusion.
   */
  function claimRecorder(): {
    posts: Array<{ auth: string; captcha: string; proxy?: string }>;
    fetchStub: typeof fetch;
  } {
    const posts: Array<{ auth: string; captcha: string; proxy?: string }> = [];
    let jwt1SawPlan = false;
    const fetchStub = ((_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (init?.method === "POST") {
        posts.push({
          auth: headers.Authorization ?? "",
          captcha: headers["X-Aliyun-Captcha-Verify-Param"] ?? "",
          proxy: (init as { proxy?: string } | undefined)?.proxy,
        });
        return Promise.resolve(new Response(JSON.stringify({ code: 0, data: { plan: { plan_id: "egg-1" } } }), { status: 200 }));
      }
      const plans = headers.Authorization === "Bearer jwt-1" && !jwt1SawPlan ? [PLAN] : [];
      if (plans.length) jwt1SawPlan = true;
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: { plans } }), { status: 200 }));
    }) as unknown as typeof fetch;
    return { posts, fetchStub };
  }

  function rotationAuth(entries: () => PoolEntry[]): AuthManager {
    return { getPool: () => ({ snapshotEntries: entries, exitTargets: () => TARGETS }) } as unknown as AuthManager;
  }

  test("stalled mint probes unused nodes, re-pins, and claims through the new exit", async () => {
    const entries = [entry(1, true, DEAD), entry(2, true, USED)];
    const { posts, fetchStub } = claimRecorder();
    const mintUrls: string[] = [];
    const pins: Array<{ id: string; node: string }> = [];
    const fan = startAutoClaim(config, rotationAuth(() => entries), fetchStub, 0, {
      mintViaExit: async (_appVersion, url) => {
        mintUrls.push(url);
        if (url === CAND_B) return { verifyParam: "rotated-token", region: "cn" };
        throw new Error(STALL.message);
      },
      pinSaver: async (id, node) => {
        pins.push({ id, node });
        // Simulate the pool rebuild: the account now egresses via the new pin.
        const e = entries.find((x) => x.id === id);
        if (e) e.proxyUrl = TARGETS.find((t) => t.label === node)?.url;
      },
    });
    try {
      await sleep(300);
      // Mint order: pinned DEAD first, then candidates AFTER ikuu-05 in label
      // order, skipping USED (owned by account 2) — ikuu-07 fails, ikuu-13 wins.
      expect(mintUrls).toEqual([DEAD, CAND_A, CAND_B]);
      expect(pins).toEqual([{ id: "oauth:zai:key1", node: "ikuu-13" }]);
      // The claim POST used the probe token AND egressed via the new exit.
      expect(posts).toHaveLength(1);
      expect(posts[0].auth).toBe("Bearer jwt-1");
      expect(posts[0].captcha).toBe("rotated-token");
      expect(posts[0].proxy).toBe(CAND_B);
      // Account 2's idle previews never minted anything.
      expect(mintUrls.every((u) => u !== USED)).toBe(true);
    } finally {
      fan.stop();
    }
  });

  test("all candidate nodes unhealthy: no claim, pin untouched, mint kept to the same node", async () => {
    const entries = [entry(1, true, DEAD), entry(2, true, USED)];
    const { posts, fetchStub } = claimRecorder();
    const pins: string[] = [];
    const fan = startAutoClaim(config, rotationAuth(() => entries), fetchStub, 0, {
      mintViaExit: async () => {
        throw new Error(STALL.message);
      },
      pinSaver: async (_id, node) => {
        pins.push(node);
      },
    });
    try {
      await sleep(250);
      expect(posts).toHaveLength(0);
      expect(pins).toHaveLength(0);
      expect(entries[0].proxyUrl).toBe(DEAD);
    } finally {
      fan.stop();
    }
  });

  test("non-stall mint errors (e.g. configs fetch down) never trigger rotation", async () => {
    const entries = [entry(1, true, DEAD)];
    const { posts, fetchStub } = claimRecorder();
    const mintUrls: string[] = [];
    const fan = startAutoClaim(config, rotationAuth(() => entries), fetchStub, 0, {
      mintViaExit: async (_appVersion, url) => {
        mintUrls.push(url);
        throw new Error("Captcha config unavailable");
      },
    });
    try {
      await sleep(200);
      expect(posts).toHaveLength(0);
      // Repeated ticks all retried the SAME pinned exit — no probe ever ran.
      expect(mintUrls.length).toBeGreaterThanOrEqual(1);
      expect(mintUrls.every((u) => u === DEAD)).toBe(true);
    } finally {
      fan.stop();
    }
  });
});

describe("runClaimCli (one-shot, all accounts)", () => {
  const cliConfig = {
    claim: { origin: "https://claim.test", planId: "", pollIntervalMs: 300_000, cooldownMs: 600_000, captchaViaExit: true },
    identity: { appVersion: "3.12.3", deviceMid: "0f0e0d0c-0000-4000-8000-000000000001" },
  } as unknown as ProxyConfig;

  // Wire shape uses snake_case (parsePlan reads plan_id).
  const PLAN = { plan_id: "egg-1", name: "Egg", description: "", priority: 1, entitlements: [] };

  function stubCreds(n: number): Credential[] {
    return Array.from({ length: n }, (_, i) => ({
      apiKey: `cli-key-${i}`,
      provider: "zai",
      jwt: `cli-jwt-${i}`,
    })) as Credential[];
  }

  test("now mode claims for EVERY stored account, each with its own JWT, gapped", async () => {
    const creds = stubCreds(2);
    const claimPosts: Array<{ auth: string; captcha: string }> = [];
    const fetchStub = ((_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (init?.method === "POST") {
        claimPosts.push({ auth: headers.Authorization ?? "", captcha: headers["X-Aliyun-Captcha-Verify-Param"] ?? "" });
        // First account succeeds, second is risk-blocked — exercises both arms.
        const ok = headers.Authorization === "Bearer cli-jwt-0";
        return Promise.resolve(
          new Response(JSON.stringify(ok ? { code: 0, data: { plan: { plan_id: "egg-1" } } } : { code: 3012, msg: "blocked" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: { plans: [PLAN] } }), { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await runClaimCli(cliConfig, "now", {
      gapMs: 0,
      fetchImpl: fetchStub,
      getCaptcha: async () => ({ verifyParam: "cap-param", region: "sgp" }),
      loadCreds: async () => creds,
    });

    expect(res).toEqual({ attempted: 2, claimed: 1, failed: 1 });
    expect(claimPosts.map((p) => p.auth)).toEqual(["Bearer cli-jwt-0", "Bearer cli-jwt-1"]);
    expect(claimPosts.every((p) => p.captcha === "cap-param")).toBe(true);
  });

  test("gap between accounts is real (not one burst), and list mode never claims", async () => {
    const creds = stubCreds(2);
    const gapSamples: number[] = [];
    let last = 0;
    const fetchStub = ((_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const now = Date.now();
        if (last) gapSamples.push(now - last);
        last = now;
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: { plans: [PLAN] } }), { status: 200 }));
    }) as unknown as typeof fetch;

    await runClaimCli(cliConfig, "list", {
      fetchImpl: fetchStub,
      getCaptcha: async () => ({ verifyParam: "cap", region: "sgp" }),
      loadCreds: async () => creds,
    });
    expect(gapSamples.length).toBe(0); // list is read-only

    last = 0;
    gapSamples.length = 0;
    await runClaimCli(cliConfig, "now", {
      gapMs: 120,
      fetchImpl: fetchStub,
      getCaptcha: async () => ({ verifyParam: "cap", region: "sgp" }),
      loadCreds: async () => creds,
    });
    expect(gapSamples.length).toBe(1);
    expect(gapSamples[0]).toBeGreaterThanOrEqual(80); // ~120ms gap, timer tolerance
  });

  test("no stored JWTs reports and counts one failure (old exit-1 behavior)", async () => {
    const res = await runClaimCli(cliConfig, "now", {
      loadCreds: async () => [] as Credential[],
    });
    expect(res).toEqual({ attempted: 0, claimed: 0, failed: 1 });
  });
});
