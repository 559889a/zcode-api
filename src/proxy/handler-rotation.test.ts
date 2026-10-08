/**
 * Rotation-loop tests for proxyRequest — the account-pool integration on the
 * chat hot path. Uses coding-plan passthrough (anthropic format) so upstream
 * statuses surface verbatim, and `retry-after: 0` responses so no backoff
 * sleeps are needed.
 *
 * Covers: sequential in-request retry on 429, cooldown → account switch,
 * per-account provider routing (mixed zai/bigmodel pool), 5xx never counting
 * as key failures, and the give-up cap returning the last upstream error.
 */
import { describe, it, expect, mock } from "bun:test";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { AccountPool, configAccountEntry, oauthAccountEntry } from "../pool/pool.js";

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

const TEST_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: {},
  provider: "zai",
  plan: "coding-plan",
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: IDENTITY,
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
  endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
  clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
  mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
  async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, captchaViaExit: true, planId: "" },
  logging: { level: "info" },
};

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_rotation",
  type: "message",
  role: "assistant",
  model: "glm-4.6",
  content: [{ type: "text", text: "rotation reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

function clientRequest(): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

interface Call {
  url: string;
  apiKey: string | null;
}

function rateLimited(status: number, body = '{"error":{"type":"rate_limit"}}'): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", "retry-after": "0" } });
}

/** The live biz-1005 wire shape (HTTP 200 + JSON); retry-after: 0 keeps tests sleep-free. */
function quotaExhausted(): Response {
  return new Response('{"code":1005,"msg":"exceed quota limit","logid":"x"}', {
    status: 200,
    headers: { "content-type": "application/json", "retry-after": "0" },
  });
}

describe("proxyRequest — account pool rotation", () => {
  it("retries the same account on 429 until it succeeds (retry-after: 0 keeps the test sleep-free)", async () => {
    const auth = new AuthManager();
    const entry = configAccountEntry({ label: "a", provider: "zai", apiKey: "key-a" }, 0);
    auth.setPool(new AccountPool([entry], { failureThreshold: 10, onEvent: () => {} }));

    let calls = 0;
    const fetchMock = (async (req: Request) => {
      calls += 1;
      if (calls <= 9) return rateLimited(429);
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    expect(resp.status).toBe(200);
    expect(calls).toBe(10); // nine strikes, then the success
    expect(await resp.text()).toBe(ANTHROPIC_OK);
  });

  it("cools the first account down at the threshold and routes the next account to ITS provider", async () => {
    const auth = new AuthManager();
    const a = configAccountEntry({ label: "za", provider: "zai", apiKey: "key-a" }, 0);
    const b = configAccountEntry({ label: "bm", provider: "bigmodel", apiKey: "key-b" }, 1);
    auth.setPool(new AccountPool([a, b], { failureThreshold: 2, onEvent: () => {} }));

    const calls: Call[] = [];
    const fetchMock = (async (req: Request) => {
      const auth1 = req.headers.get("authorization") ?? "";
      calls.push({ url: req.url, apiKey: auth1.replace("Bearer ", "") });
      // zai account (key-a) is always rate-limited; bigmodel (key-b) succeeds.
      if (auth1.includes("key-a")) return rateLimited(429);
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(3); // key-a 429, key-a 429 (cooled), key-b 200
    expect(calls[0].url.startsWith("https://api.z.ai/")).toBe(true); // zai entry → zai endpoints
    expect(calls[2].url.startsWith("https://open.bigmodel.cn/")).toBe(true); // bigmodel entry → bigmodel endpoints
    expect(calls[2].apiKey).toBe("key-b");
    // Pool state: b is current, a is cooling.
    const status = auth.getPool()!.status();
    expect(status[0].cooling).toBe(true);
    expect(status[1].cooling).toBe(false);
    expect(status[1].current).toBe(true);
  });

  it("rotates on biz-1005 quota exhaustion hidden behind HTTP 200 — cools at once, next account serves", async () => {
    const auth = new AuthManager();
    const a = configAccountEntry({ label: "a", provider: "zai", apiKey: "key-a" }, 0);
    const b = configAccountEntry({ label: "b", provider: "zai", apiKey: "key-b" }, 1);
    auth.setPool(new AccountPool([a, b], { failureThreshold: 10, onEvent: () => {} }));

    const calls: string[] = [];
    const fetchMock = (async (req: Request) => {
      const key = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      calls.push(key);
      // Account a is quota-dead: HTTP 200 + the biz-1005 envelope (the live
      // 2026-10-08 wire shape). Account b is healthy.
      if (key === "key-a") {
        return quotaExhausted();
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(ANTHROPIC_OK);
    expect(calls).toEqual(["key-a", "key-b"]); // cooled after ONE failure — no 10-strike ladder
    const st = auth.getPool()!.status();
    expect(st[0].cooling).toBe(true);
    expect(st[0].strikes).toBe(0);
    expect(st[1].current).toBe(true);
  });

  it("every account quota-dead: retries through the pool, then surfaces the 200 envelope verbatim", async () => {
    const auth = new AuthManager();
    const entry = configAccountEntry({ label: "a", provider: "zai", apiKey: "key-a" }, 0);
    auth.setPool(new AccountPool([entry], { failureThreshold: 10, onEvent: () => {} }));

    let calls = 0;
    const fetchMock = (async (_req: Request) => {
      calls += 1;
      return quotaExhausted();
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    // Every pool entry probed budget-dead this request short-circuits the
    // loop: one probe, envelope surfaced — no pointless revival cycling.
    expect(calls).toBe(1);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('"code":1005');
  });

  it("biz-1113 insufficient balance behind HTTP 429 cools immediately instead of the 10-strike ladder", async () => {
    const auth = new AuthManager();
    const a = configAccountEntry({ label: "a", provider: "zai", apiKey: "key-a" }, 0);
    const b = configAccountEntry({ label: "b", provider: "zai", apiKey: "key-b" }, 1);
    auth.setPool(new AccountPool([a, b], { failureThreshold: 10, onEvent: () => {} }));

    const calls: string[] = [];
    const fetchMock = (async (req: Request) => {
      const key = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      calls.push(key);
      if (key === "key-a") {
        // The raw api.z.ai plane's balance-dead shape (captured 2026-10-08).
        return new Response('{"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"[1113][Insufficient balance or no resource package.]"}}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(ANTHROPIC_OK);
    expect(calls).toEqual(["key-a", "key-b"]); // one probe, not ten strikes
    expect(auth.getPool()!.status()[0].cooling).toBe(true);
  });

  it("never counts 5xx as key failures — passed through untouched, no strikes (shared outages must not burn the pool)", async () => {
    const auth = new AuthManager();
    const entry = configAccountEntry({ label: "a", provider: "zai", apiKey: "key-a" }, 0);
    auth.setPool(new AccountPool([entry], { failureThreshold: 2, onEvent: () => {} }));

    let calls = 0;
    const fetchMock = (async (req: Request) => {
      calls += 1;
      return new Response("upstream exploded", { status: 500 });
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    expect(resp.status).toBe(500); // passthrough, no retry — not a key signal
    expect(calls).toBe(1);
    expect(auth.getPool()!.status()[0].strikes).toBe(0);
    expect(auth.getPool()!.status()[0].cooling).toBe(false);
  });

  it("gives up after threshold×size+5 attempts and surfaces the last upstream error", async () => {
    const auth = new AuthManager();
    const entry = configAccountEntry({ label: "a", provider: "zai", apiKey: "key-a" }, 0);
    auth.setPool(new AccountPool([entry], { failureThreshold: 2, onEvent: () => {} }));

    let calls = 0;
    const fetchMock = (async (req: Request) => {
      calls += 1;
      return rateLimited(429);
    }) as typeof fetch;

    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    // maxAttempts = 1×2 + 5 = 7
    expect(calls).toBe(7);
    expect(resp.status).toBe(429); // passthrough of the last upstream error
  });

  it("legacy single-account path (no pool) passes a 429 through untouched, exactly one upstream call", async () => {
    const auth = new AuthManager();
    auth.setOAuthCredential({ apiKey: "key-legacy", provider: "zai" });
    let calls = 0;
    const fetchMock = (async (req: Request) => {
      calls += 1;
      return rateLimited(429);
    }) as typeof fetch;
    const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
    expect(resp.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("per-account plan: an oauth entry pinned to start-plan hits the zcode-plan gateway; without a JWT it stays coding-plan", async () => {
    // Same module-mock technique as handler-resilience.test.ts — the start-plan
    // path lazily loads captcha.ts, which must not hit the network here.
    mock.module("./captcha.js", () => ({
      detectCaptchaChallenge: () => null,
      getCaptchaToken: async () => { throw new Error("no captcha in this test"); },
      RETRY_HEADERS: { PARAM: "x-aliyun-captcha-verify-param", REGION: "x-aliyun-captcha-verify-region" },
    }));

    const run = async (cred: { apiKey: string; jwt?: string; plan?: "coding-plan" | "start-plan" }): Promise<string[]> => {
      const auth = new AuthManager();
      const oa = oauthAccountEntry({ provider: "zai", ...cred }, 0, "coding-plan");
      auth.setPool(new AccountPool([oa], { onEvent: () => {} }));
      const urls: string[] = [];
      const fetchMock = (async (req: Request) => {
        urls.push(req.url);
        return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const resp = await proxyRequest(clientRequest(), "anthropic", { config: TEST_CONFIG, auth, fetchImpl: fetchMock });
      expect(resp.status).toBe(200);
      return urls;
    };

    // Global config.plan is coding-plan; only the entry's own plan (and its JWT) decides.
    expect((await run({ apiKey: "k1", jwt: "jwt-1", plan: "start-plan" }))[0]).toContain("zcode-plan");
    expect((await run({ apiKey: "k1", plan: "start-plan" }))[0]).toContain("api.z.ai"); // no JWT → coding-plan fallback
    expect((await run({ apiKey: "k1", jwt: "jwt-1" }))[0]).toContain("api.z.ai"); // default plan → coding-plan
  });
});
