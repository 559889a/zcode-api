import { describe, it, expect, afterEach } from "bun:test";
import net from "node:net";
import {
  createControlDispatcher,
  LogBuffer,
  type ControlCommand,
  type ControlState,
  type HandlerContext,
} from "./control.js";
import { BigmodelOAuthClient } from "./auth/oauth.js";

/** Dispatcher with only the given hooks wired (logBuffer always present). */
function dispatcher(state: ControlState, ctx?: Partial<HandlerContext>) {
  return createControlDispatcher(state, { logBuffer: new LogBuffer(), ...ctx });
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
    if (res.ok && "plan" in res) {
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
