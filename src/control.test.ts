import { describe, it, expect, afterEach } from "bun:test";
import net from "node:net";
import {
  createControlDispatcher,
  LogBuffer,
  type ControlCommand,
  type ControlState,
  type HandlerContext,
} from "./control.js";
import { BigmodelOAuthClient, OAuthFlowClient, type OAuthFlowStart, type OAuthFlowTokens } from "./auth/oauth.js";
import type { ProviderId } from "./provider/types.js";

/** Dispatcher with only the given hooks wired (logBuffer always present). */
function dispatcher(state: ControlState, ctx?: Partial<HandlerContext>) {
  return createControlDispatcher(state, { logBuffer: new LogBuffer(), ...ctx });
}

/** Offline flow client whose `complete()` settles a caller-controlled promise. */
class StubFlowClient extends OAuthFlowClient {
  constructor(
    provider: ProviderId,
    private readonly outcome: Promise<OAuthFlowTokens>,
  ) {
    super(provider, (() => {
      throw new Error("stub client must not touch the network");
    }) as unknown as typeof fetch);
  }
  override async start(): Promise<OAuthFlowStart> {
    return { authorizeUrl: "https://example/authorize", callbackUrl: "", state: "stub-state" };
  }
  override complete(): Promise<OAuthFlowTokens> {
    return this.outcome;
  }
  override async close(): Promise<void> {}
}

describe("control dispatcher", () => {
  const baseState: ControlState = {
    provider: "bigmodel",
    plan: "coding-plan",
    proxyPort: 8080,
  };

  it("returns running status for {cmd:status}", async () => {
    const res = await dispatcher(baseState)({ cmd: "status" });
    expect(res.ok).toBe(true);
    if (res.ok && "state" in res) {
      expect(res.state).toBe("running");
      expect(res.provider).toBe("bigmodel");
      expect(res.plan).toBe("coding-plan");
      expect(res.proxyPort).toBe(8080);
    }
  });

  it("returns error for unknown cmd", async () => {
    const res = await dispatcher(baseState)({ cmd: "bogus" } as unknown as ControlCommand);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("unknown_cmd");
    }
  });

  it("returns error for deliverOAuthCode without an active flow", async () => {
    const res = await dispatcher(baseState)({
      cmd: "deliverOAuthCode", provider: "bigmodel", code: "x", state: "y",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("no_matching_oauth_flow");
    }
  });
});

describe("control dispatcher — lifecycle commands", () => {
  const state: ControlState = {
    provider: "bigmodel",
    plan: "coding-plan",
    proxyPort: 0,
  };

  it("startProxy calls hook and updates state.proxyPort", async () => {
    const res = await dispatcher(state, { onStartProxy: async () => ({ ok: true, port: 9999 }) })({ cmd: "startProxy" });
    expect(res.ok).toBe(true);
    if (res.ok && "port" in res) {
      expect(res.port).toBe(9999);
    }
    expect(state.proxyPort).toBe(9999);
  });

  it("startProxy surfaces hook errors", async () => {
    const res = await dispatcher(state, { onStartProxy: async () => ({ ok: false, error: "not_logged_in" }) })({ cmd: "startProxy" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("not_logged_in");
    }
  });

  it("startProxy returns error when hook missing", async () => {
    const res = await dispatcher(state)({ cmd: "startProxy" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("proxy_lifecycle_unavailable");
    }
  });

  it("stopProxy resets state.proxyPort to 0", async () => {
    state.proxyPort = 8080;
    const res = await dispatcher(state, { onStopProxy: async () => ({ ok: true }) })({ cmd: "stopProxy" });
    expect(res.ok).toBe(true);
    expect(state.proxyPort).toBe(0);
  });
});

describe("control dispatcher — setConfig", () => {
  it("updates provider and plan via hook and syncs state", async () => {
    const state: ControlState = { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 };
    const res = await dispatcher(state, {
      onSetConfig: async (changes) => ({
        ok: true,
        provider: changes.provider ?? state.provider,
        plan: changes.plan ?? state.plan,
      }),
    })({ cmd: "setConfig", provider: "zai", plan: "start-plan" });
    expect(res.ok).toBe(true);
    if (res.ok && "event" in res && res.event === "configUpdated") {
      expect(res.provider).toBe("zai");
      expect(res.plan).toBe("start-plan");
    }
    expect(state.provider).toBe("zai");
    expect(state.plan).toBe("start-plan");
  });

  it("returns config_update_unavailable when hook missing", async () => {
    const state: ControlState = { provider: "zai", plan: "coding-plan", proxyPort: 0 };
    const res = await dispatcher(state)({ cmd: "setConfig", provider: "bigmodel" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("config_update_unavailable");
    }
  });
});

describe("control dispatcher — getLogs", () => {
  it("returns all lines when since=0", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("[INFO] line one");
    logBuffer.push("[INFO] line two");
    const res = await dispatcher({ provider: "bigmodel", plan: "coding-plan", proxyPort: 0 }, { logBuffer })({ cmd: "getLogs" });
    expect(res.ok).toBe(true);
    if (res.ok && "lines" in res) {
      expect(res.lines).toEqual(["[INFO] line one", "[INFO] line two"]);
      expect(res.nextSince).toBe(2);
    }
  });

  it("returns only lines after `since`", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("a");
    logBuffer.push("b");
    logBuffer.push("c");
    const res = await dispatcher({ provider: "bigmodel", plan: "coding-plan", proxyPort: 0 }, { logBuffer })({ cmd: "getLogs", since: 1 });
    expect(res.ok).toBe(true);
    if (res.ok && "lines" in res) {
      expect(res.lines).toEqual(["b", "c"]);
    }
  });

  it("returns empty when since is at cursor", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("only");
    const res = await dispatcher({ provider: "bigmodel", plan: "coding-plan", proxyPort: 0 }, { logBuffer })({ cmd: "getLogs", since: 1 });
    expect(res.ok).toBe(true);
    if (res.ok && "lines" in res) {
      expect(res.lines).toEqual([]);
    }
  });
});

describe("control dispatcher — quota", () => {
  const state: ControlState = { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 };
  const snapshot = {
    provider: "bigmodel",
    serverTime: 1759195200,
    jwt: null,
    balances: [],
    claimablePlans: [],
    codingPlan: { level: "max", limits: [{ type: "TIME_LIMIT", remaining: 3894 }] },
    errors: [],
  };

  it("returns the snapshot from the onQuota hook", async () => {
    const res = await dispatcher(state, { onQuota: async () => snapshot })({ cmd: "quota" });
    expect(res.ok).toBe(true);
    if (res.ok && "quota" in res) {
      expect(res.quota).toEqual(snapshot);
      expect(res.quota.codingPlan?.level).toBe("max");
    }
  });

  it("returns quota_unavailable when the hook is missing", async () => {
    const res = await dispatcher(state)({ cmd: "quota" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("quota_unavailable");
    }
  });

  it("surfaces hook failures verbatim (not-logged-in message)", async () => {
    const res = await dispatcher(state, {
      onQuota: async () => {
        throw new Error("not logged in (run: zcode-proxy auth login)");
      },
    })({ cmd: "quota" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("not logged in");
    }
  });
});

describe("control dispatcher startOAuth callback-port lifecycle", () => {
  /** Find a free loopback TCP port (bind port 0, read back, close). */
  async function freePort(): Promise<number> {

    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
  }

  /** True when nothing is listening on `port` anymore. */
  async function portIsFree(port: number): Promise<boolean> {

    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
  }

  afterEach(() => {
    delete process.env.ZCODE_OAUTH_CALLBACK_PORT;
  });

  it("releases the callback port when the flow is rejected (abandoned login)", async () => {
    const port = await freePort();
    process.env.ZCODE_OAUTH_CALLBACK_PORT = String(port);
    const state: ControlState = { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 };
    // Inject the classic (localhost-callback) client: the port-lifecycle
    // guarantee is a callback-flow property; the default bigmodel login is
    // the network-bound poll flow, which binds nothing.
    const dispatch = dispatcher(state, { createLoginClient: () => new BigmodelOAuthClient() });

    const started = await dispatch({ cmd: "startOAuth", provider: "bigmodel" });
    expect(started.ok).toBe(true);
    expect(state.activeOauth).toBeDefined();

    // Simulate the user abandoning the flow: a callback with a bad state
    // rejects every waitForCallback waiter.
    const resp = await fetch(`http://127.0.0.1:${port}/oauth/callback/bigmodel?state=bad&code=x`);
    expect(resp.status).toBe(400);
    await Bun.sleep(50);

    expect(state.activeOauth).toBeUndefined();
    expect(await portIsFree(port)).toBe(true);
  });

  it("a second startOAuth tears down the previous flow instead of hitting EADDRINUSE", async () => {
    const port = await freePort();
    process.env.ZCODE_OAUTH_CALLBACK_PORT = String(port);
    const state: ControlState = { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 };
    const dispatch = dispatcher(state, { createLoginClient: () => new BigmodelOAuthClient() });

    const first = await dispatch({ cmd: "startOAuth", provider: "bigmodel" });
    expect(first.ok).toBe(true);

    // Previously this threw EADDRINUSE (500) because the first flow still
    // held the fixed callback port.
    const second = await dispatch({ cmd: "startOAuth", provider: "bigmodel" });
    expect(second.ok).toBe(true);

    // Clean up the flow started by the second command.
    state.activeOauth?.client.close().catch(() => {});
    state.activeOauth = undefined;
    await Bun.sleep(50);
  });
});

describe("control dispatcher — oauth status slice", () => {
  it("status shows the in-flight flow as pending, then the failure once it settles", async () => {
    let rejectOutcome: (err: Error) => void = () => {};
    const outcome = new Promise<OAuthFlowTokens>((_, reject) => { rejectOutcome = reject; });
    const state: ControlState = { provider: "zai", plan: "coding-plan", proxyPort: 0 };
    const dispatch = dispatcher(state, {
      createLoginClient: (provider) => new StubFlowClient(provider, outcome),
    });

    await dispatch({ cmd: "startOAuth", provider: "zai" });
    const pending = await dispatch({ cmd: "status" });
    expect(pending).toMatchObject({
      ok: true,
      oauth: { provider: "zai", state: "pending" },
    });

    rejectOutcome(new Error("Authorization timed out. Please retry login."));
    await Bun.sleep(20); // let the .catch/.finally microtasks settle

    const failed = await dispatch({ cmd: "status" });
    expect(failed).toMatchObject({
      ok: true,
      oauth: { provider: "zai", state: "failed", error: "Authorization timed out. Please retry login." },
    });
    expect(state.activeOauth).toBeUndefined();
  });

  it("a new startOAuth replaces the stale last outcome", async () => {
    let rejectFirst: (err: Error) => void = () => {};
    const first = new Promise<OAuthFlowTokens>((_, reject) => { rejectFirst = reject; });
    let rejectSecond: (err: Error) => void = () => {};
    const second = new Promise<OAuthFlowTokens>((_, reject) => { rejectSecond = reject; });
    const state: ControlState = { provider: "zai", plan: "coding-plan", proxyPort: 0 };
    let call = 0;
    const dispatch = dispatcher(state, {
      createLoginClient: (provider) => (call++ === 0 ? new StubFlowClient(provider, first) : new StubFlowClient(provider, second)),
    });

    await dispatch({ cmd: "startOAuth", provider: "zai" });
    rejectFirst(new Error("first failed"));
    await Bun.sleep(20);
    const failed = await dispatch({ cmd: "status" });
    expect(failed).toMatchObject({ oauth: { state: "failed" } });

    await dispatch({ cmd: "startOAuth", provider: "zai" });
    const pending = await dispatch({ cmd: "status" });
    expect(pending).toMatchObject({ oauth: { state: "pending" } });
    rejectSecond(new Error("done"));
    await Bun.sleep(20);
  });
});

describe("LogBuffer", () => {
  it("evicts oldest lines past capacity", () => {
    const buf = new LogBuffer(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect([...buf.snapshot()]).toEqual(["b", "c", "d"]);
    expect(buf.cursor).toBe(4);
  });

  it("since() with stale cursor returns all surviving lines", () => {
    const buf = new LogBuffer(2);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    // "a" was evicted; since=0 still returns only surviving lines.
    const result = buf.since(0);
    expect(result.lines).toEqual(["b", "c"]);
    expect(result.nextSince).toBe(3);
  });
});

describe("control dispatcher — account pool", () => {
  it("poolStatus forwards the getPoolStatus hook plus nodes and threshold", async () => {
    const dispatch = dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {
      getPoolStatus: () => [
        { id: "cfg:a", label: "a", provider: "zai", source: "config", plan: "coding-plan", strikes: 1, cooling: false, current: true },
      ],
      getPoolNodes: () => ["n1", "n2"],
      getPoolThreshold: () => 4,
    });
    const res = await dispatch({ cmd: "poolStatus" });
    expect(res).toEqual({
      ok: true,
      event: "pool",
      pool: [{ id: "cfg:a", label: "a", provider: "zai", source: "config", plan: "coding-plan", strikes: 1, cooling: false, current: true }],
      nodes: ["n1", "n2"],
      threshold: 4,
    });
  });

  it("poolStatus without the hook returns pool_unavailable", async () => {
    const res = await dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {})({ cmd: "poolStatus" });
    expect(res).toEqual({ ok: false, error: "pool_unavailable" });
  });

  it("updateAccount forwards plan/proxy changes to the hook", async () => {
    const seen: Array<{ id: string; plan?: string; proxy?: string }> = [];
    const dispatch = dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {
      onUpdateAccount: async (id, changes) => {
        seen.push({ id, ...changes });
        return { ok: true, plan: changes.plan, proxy: changes.proxy ?? "" };
      },
    });
    const res = await dispatch({ cmd: "updateAccount", id: "oauth:zai:k1", plan: "start-plan", proxy: "ikuu-07" });
    expect(res).toEqual({ ok: true, event: "accountUpdated", id: "oauth:zai:k1", plan: "start-plan", proxy: "ikuu-07" });
    expect(seen).toEqual([{ id: "oauth:zai:k1", plan: "start-plan", proxy: "ikuu-07" }]);
  });

  it("updateAccount clears a node pin with an empty proxy string", async () => {
    const seen: Array<{ id: string; proxy?: string }> = [];
    const dispatch = dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {
      onUpdateAccount: async (id, changes) => {
        seen.push({ id, proxy: changes.proxy });
        return { ok: true, proxy: changes.proxy ?? "" };
      },
    });
    const res = await dispatch({ cmd: "updateAccount", id: "oauth:zai:k1", proxy: "" });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ id: "oauth:zai:k1", proxy: "" }]);
  });

  it("updateAccount surfaces hook errors verbatim", async () => {
    const dispatch = dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {
      onUpdateAccount: async () => ({ ok: false, error: "config accounts are edited in config.yaml (pool.accounts)" }),
    });
    const res = await dispatch({ cmd: "updateAccount", id: "cfg:a", plan: "start-plan" });
    expect(res).toEqual({ ok: false, error: "config accounts are edited in config.yaml (pool.accounts)" });
  });

  it("removeAccount forwards the hook and reports the id", async () => {
    const removed: string[] = [];
    const dispatch = dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {
      onRemoveAccount: async (id) => {
        removed.push(id);
        return { ok: true };
      },
    });
    const res = await dispatch({ cmd: "removeAccount", id: "oauth:zai:k1" });
    expect(res).toEqual({ ok: true, event: "accountRemoved", id: "oauth:zai:k1" });
    expect(removed).toEqual(["oauth:zai:k1"]);
  });

  it("removeAccount surfaces hook errors and skips the success event", async () => {
    const dispatch = dispatcher({ provider: "zai", plan: "coding-plan", proxyPort: 0 }, {
      onRemoveAccount: async () => ({ ok: false, error: "unknown account: cfg:x" }),
    });
    const res = await dispatch({ cmd: "removeAccount", id: "cfg:x" });
    expect(res).toEqual({ ok: false, error: "unknown account: cfg:x" });
  });
});
