/**
 * In-process control protocol shared by the `serve` web panel.
 *
 * The panel's `POST /api/control` hands parsed JSON commands to
 * `createControlDispatcher()`: identical command semantics to the retired
 * Android loopback listener, but with no listener of its own — the caller
 * owns its transport and must guard it (token, origin, size limits), so a
 * reachable panel never also opens a second, unauthenticated port that can
 * run stopProxy / logout / shutdown.
 */
import type { ProviderId } from "./provider/types.js";
import type { Credential } from "./auth/types.js";
import type { PoolStatusEntry } from "./pool/pool.js";
import {
  ZaiOAuthClient,
  BigmodelPollOAuthClient,
  AuthCodeOAuthClient,
  type OAuthFlowClient,
} from "./auth/oauth.js";
import { KeyResolver } from "./auth/resolver.js";
import { saveCredential, clearCredential, loadCredential } from "./auth/store.js";
import type { QuotaSnapshot } from "./server/routes-quota.js";

/** Supported plan tiers. Mirrors `ProxyConfig.plan`. */
export type PlanTier = "coding-plan" | "start-plan";

/** The control protocol: request shape for a dispatched command. */
export type ControlCommand =
  | { cmd: "status" }
  | { cmd: "startOAuth"; provider: ProviderId }
  | { cmd: "deliverOAuthCode"; provider: ProviderId; code: string; state: string }
  | { cmd: "logout" }
  | { cmd: "setConfig"; provider?: ProviderId; plan?: PlanTier }
  | { cmd: "startProxy" }
  | { cmd: "stopProxy" }
  | { cmd: "getLogs"; since?: number }
  | { cmd: "quota" }
  | { cmd: "poolStatus" }
  | { cmd: "removeAccount"; id: string }
  | { cmd: "updateAccount"; id: string; plan?: PlanTier; proxy?: string }
  | { cmd: "shutdown" };

/** Successful response envelope. */
export type ControlOk =
  | { ok: true; state: "running"; provider: ProviderId; plan: PlanTier; proxyPort: number; loggedIn: boolean; oauth?: OAuthStatusSlice }
  | { ok: true; event: "oauthUrl"; authorizeUrl: string; callbackPort: number }
  | { ok: true; event: "loginOk"; provider: ProviderId }
  | { ok: true; event: "loggedOut" }
  | { ok: true; event: "configUpdated"; provider: ProviderId; plan: PlanTier }
  | { ok: true; event: "proxyStarted"; port: number }
  | { ok: true; event: "proxyStopped" }
  | { ok: true; event: "logs"; nextSince: number; lines: string[] }
  | { ok: true; event: "quota"; quota: QuotaSnapshot }
  | { ok: true; event: "pool"; pool: PoolStatusEntry[]; nodes: string[]; threshold: number }
  | { ok: true; event: "accountRemoved"; id: string }
  | { ok: true; event: "accountUpdated"; id: string; plan?: PlanTier; proxy?: string }
  | { ok: true; event: "shuttingDown" };

/** Failure response envelope. */
export interface ControlError {
  ok: false;
  error: string;
}

export type ControlResponse = ControlOk | ControlError;

/** Result type returned by lifecycle hooks (start/stop proxy). */
export type LifecycleResult =
  | { ok: true; port: number }
  | { ok: false; error: string };

/** Result type returned by `setConfig` hook. */
export type ConfigUpdateResult =
  | { ok: true; provider: ProviderId; plan: PlanTier }
  | { ok: false; error: string };

/** Internal mutable state shared with the proxy entry. */
export interface ControlState {
  provider: ProviderId;
  plan: PlanTier;
  /** Currently-bound proxy server port. 0 when proxy is stopped. */
  proxyPort: number;
  /** Active OAuth client while a flow is in flight; nulled on completion. */
  activeOauth?: {
    client: OAuthFlowClient;
    callbackUrl: string;
    state: string;
    /** Epoch ms when the flow started (panel age display). */
    startedAt: number;
  };
  /**
   * Outcome of the most recent FINISHED flow (completed or failed), so the
   * panel can show a result after `activeOauth` is gone. Replaced by the next
   * startOAuth; never carries credentials.
   */
  lastOauth?: {
    provider: ProviderId;
    startedAt: number;
    finishedAt: number;
    state: "completed" | "failed";
    error?: string;
  };
}

/** Wire-safe OAuth flow status derived from `ControlState` (no credentials). */
export interface OAuthStatusSlice {
  provider: ProviderId;
  startedAt: number;
  state: "pending" | "completed" | "failed";
  error?: string;
  finishedAt?: number;
}

/** Context passed to the dispatcher for hook wiring + log access. */
export interface HandlerContext {
  onStartProxy?: () => Promise<LifecycleResult>;
  onStopProxy?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onSetConfig?: (changes: { provider?: ProviderId; plan?: PlanTier }) => Promise<ConfigUpdateResult>;
  onShutdown?: () => Promise<void> | void;
  onQuota?: () => Promise<QuotaSnapshot>;
  /** Live account-pool status for the panel card (wire-safe, no credentials). */
  getPoolStatus?: () => PoolStatusEntry[];
  /** Exit-node labels available for per-account binding, in node order. */
  getPoolNodes?: () => string[];
  /** Consecutive key errors before an account cools down (pool config). */
  getPoolThreshold?: () => number;
  /** Remove a pool account (oauth-store entry). Config accounts are edited in config.yaml instead. */
  onRemoveAccount?: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Update per-account settings (plan tier, pinned exit node) on an oauth-store
   * account. `proxy: ""` clears the pin. Config accounts are config.yaml-only.
   */
  onUpdateAccount?: (
    id: string,
    changes: { plan?: PlanTier; proxy?: string },
  ) => Promise<{ ok: true; plan?: PlanTier; proxy?: string } | { ok: false; error: string }>;
  logBuffer: LogBuffer;
  /** Overrides login-client construction (tests inject offline clients). */
  createLoginClient?: (provider: ProviderId) => OAuthFlowClient;
}

/** Bounded ring buffer for runtime log lines with monotonic sequence numbers. */
export class LogBuffer {
  private readonly lines: string[] = [];
  private readonly capacity: number;
  private nextSeq = 0;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  push(line: string): void {
    this.lines.push(line);
    this.nextSeq++;
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }

  /**
   * Returns lines whose logical sequence number is `>= since`, plus the
   * next-since cursor (use as the next `since` value for incremental polling).
   */
  since(since: number): { nextSince: number; lines: string[] } {
    const baseSeq = Math.max(0, this.nextSeq - this.lines.length);
    const wantStart = Math.max(since, baseSeq);
    const offset = wantStart - baseSeq;
    if (offset >= this.lines.length) {
      return { nextSince: this.nextSeq, lines: [] };
    }
    return { nextSince: this.nextSeq, lines: this.lines.slice(offset) };
  }

  /** Returns all lines currently in the buffer. */
  snapshot(): readonly string[] {
    return this.lines;
  }

  /** Monotonic cursor; safe to expose externally. */
  get cursor(): number {
    return this.nextSeq;
  }
}

/**
 * Build an in-process dispatcher for the control protocol. Embedders that
 * expose their own authenticated HTTP surface (the `serve` web panel) call
 * this with a guarded transport, so the control commands never widen the
 * attack surface beyond that transport.
 */
export function createControlDispatcher(
  state: ControlState,
  ctx: HandlerContext,
): (cmd: ControlCommand) => Promise<ControlResponse> {
  return (cmd) => dispatch(cmd, state, ctx);
}

/**
 * Build the wire-safe OAuth status slice for `status` responses: the active
 * flow while in flight, otherwise the last finished outcome (until the next
 * startOAuth replaces it).
 */
function oauthStatusSlice(state: ControlState): { oauth?: OAuthStatusSlice } {
  if (state.activeOauth) {
    return { oauth: { provider: state.activeOauth.client.provider, startedAt: state.activeOauth.startedAt, state: "pending" } };
  }
  const last = state.lastOauth;
  if (!last) return {};
  return {
    oauth: {
      provider: last.provider,
      startedAt: last.startedAt,
      state: last.state,
      ...(last.error ? { error: last.error } : {}),
      finishedAt: last.finishedAt,
    },
  };
}

async function dispatch(
  cmd: ControlCommand,
  state: ControlState,
  ctx: HandlerContext,
): Promise<ControlResponse> {
  switch (cmd.cmd) {
    case "status": {
      const cred = await loadCredential().catch(() => null);
      return {
        ok: true,
        state: "running",
        provider: state.provider,
        plan: state.plan,
        proxyPort: state.proxyPort,
        loggedIn: cred != null,
        ...oauthStatusSlice(state),
      };
    }

    case "startOAuth": {
      // Tear down any previous in-flight flow so its callback port is released.
      if (state.activeOauth) {
        await state.activeOauth.client.close().catch(() => {});
        state.activeOauth = undefined;
      }
      state.lastOauth = undefined;
      // Both providers use the server-mediated poll login (ZCode 3.12.3
      // default) — no local callback; the flow completes server-side.
      const client: OAuthFlowClient = ctx.createLoginClient
        ? ctx.createLoginClient(cmd.provider)
        : cmd.provider === "bigmodel"
          ? new BigmodelPollOAuthClient()
          : new ZaiOAuthClient();
      const started = await client.start();
      const beganAt = Date.now();
      const callbackPort = started.callbackUrl
        ? Number(new URL(started.callbackUrl).port) || 80
        : 0;
      state.activeOauth = {
        client,
        callbackUrl: started.callbackUrl,
        state: started.state,
        startedAt: beganAt,
      };
      client.complete(started).then(async (tokens) => {
        const resolver = new KeyResolver();
        const cred: Credential = await resolver.resolveCodingPlanCredential(tokens.accessToken, cmd.provider, tokens.userId);
        if (tokens.jwt) cred.jwt = tokens.jwt;
        await saveCredential(cred);
        state.lastOauth = { provider: cmd.provider, startedAt: beganAt, finishedAt: Date.now(), state: "completed" };
        console.log(`OAuth completed for ${cmd.provider}`);
      }).catch((err: unknown) => {
        // Timeouts / rejections are expected when the user abandons the
        // browser; nothing to surface beyond the log buffer.
        state.lastOauth = {
          provider: cmd.provider,
          startedAt: beganAt,
          finishedAt: Date.now(),
          state: "failed",
          error: (err as Error)?.message ?? String(err),
        };
        console.error(`OAuth flow ended without success: ${(err as Error)?.message ?? String(err)}`);
      }).finally(() => {
        // MUST run on rejection too — otherwise the callback port leaks until
        // process death.
        void client.close().catch(() => {});
        if (state.activeOauth?.state === started.state) state.activeOauth = undefined;
      });
      return {
        ok: true,
        event: "oauthUrl",
        authorizeUrl: started.authorizeUrl,
        callbackPort,
      };
    }

    case "deliverOAuthCode": {
      const active = state.activeOauth;
      // Code delivery only applies to callback-based (auth-code) flows — the
      // Z.AI cli login completes via server polling and has no code to deliver.
      if (!(active?.client instanceof AuthCodeOAuthClient) || active.state !== cmd.state) {
        return { ok: false, error: "no_matching_oauth_flow" };
      }
      try {
        const { accessToken, userId, jwt } = await active.client.exchangeCode(
          cmd.code,
          active.callbackUrl,
          cmd.state,
        );
        const resolver = new KeyResolver();
        const cred: Credential = await resolver.resolveCodingPlanCredential(accessToken, cmd.provider, userId);
        if (jwt) cred.jwt = jwt;
        await saveCredential(cred);
        state.activeOauth = undefined;
        await active.client.close().catch(() => {});
        return { ok: true, event: "loginOk", provider: cmd.provider };
      } catch (err) {
        state.activeOauth = undefined;
        await active.client.close().catch(() => {});
        return { ok: false, error: `oauth_exchange_failed: ${(err as Error).message}` };
      }
    }

    case "logout": {
      await clearCredential();
      return { ok: true, event: "loggedOut" };
    }

    case "setConfig": {
      if (!ctx.onSetConfig) return { ok: false, error: "config_update_unavailable" };
      const result = await ctx.onSetConfig({ provider: cmd.provider, plan: cmd.plan });
      if (!result.ok) return result;
      state.provider = result.provider;
      state.plan = result.plan;
      return { ok: true, event: "configUpdated", provider: result.provider, plan: result.plan };
    }

    case "startProxy": {
      if (!ctx.onStartProxy) return { ok: false, error: "proxy_lifecycle_unavailable" };
      const result = await ctx.onStartProxy();
      if (!result.ok) return result;
      state.proxyPort = result.port;
      return { ok: true, event: "proxyStarted", port: result.port };
    }

    case "stopProxy": {
      if (!ctx.onStopProxy) return { ok: false, error: "proxy_lifecycle_unavailable" };
      const result = await ctx.onStopProxy();
      if (!result.ok) return result;
      state.proxyPort = 0;
      return { ok: true, event: "proxyStopped" };
    }

    case "getLogs": {
      const since = typeof cmd.since === "number" ? cmd.since : 0;
      const { nextSince, lines } = ctx.logBuffer.since(since);
      return { ok: true, event: "logs", nextSince, lines: [...lines] };
    }

    case "quota": {
      // Snapshot build hits both upstream quota planes (billing + monitor);
      // a failure (e.g. not logged in) surfaces verbatim as the envelope error
      // so clients can render a retry hint instead of an empty card.
      if (!ctx.onQuota) return { ok: false, error: "quota_unavailable" };
      try {
        const quota = await ctx.onQuota();
        return { ok: true, event: "quota", quota };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    case "poolStatus": {
      if (!ctx.getPoolStatus) return { ok: false, error: "pool_unavailable" };
      return {
        ok: true,
        event: "pool",
        pool: ctx.getPoolStatus(),
        nodes: ctx.getPoolNodes?.() ?? [],
        threshold: ctx.getPoolThreshold?.() ?? 10,
      };
    }

    case "removeAccount": {
      if (!ctx.onRemoveAccount) return { ok: false, error: "pool_unavailable" };
      const result = await ctx.onRemoveAccount(cmd.id);
      if (!result.ok) return result;
      return { ok: true, event: "accountRemoved", id: cmd.id };
    }

    case "updateAccount": {
      if (!ctx.onUpdateAccount) return { ok: false, error: "pool_unavailable" };
      const result = await ctx.onUpdateAccount(cmd.id, {
        ...(cmd.plan ? { plan: cmd.plan } : {}),
        ...(cmd.proxy !== undefined ? { proxy: cmd.proxy } : {}),
      });
      if (!result.ok) return result;
      return { ok: true, event: "accountUpdated", id: cmd.id, ...(result.plan ? { plan: result.plan } : {}), ...(result.proxy !== undefined ? { proxy: result.proxy } : {}) };
    }

    case "shutdown": {
      if (ctx.onShutdown) await ctx.onShutdown();
      return { ok: true, event: "shuttingDown" };
    }

    default:
      return { ok: false, error: `unknown_cmd: ${(cmd as { cmd: string }).cmd}` };
  }
}
