/**
 * Wiring between the claim subsystem and the rest of the proxy: builds a
 * scheduler from a loaded `ProxyConfig` + `AuthManager` (serve path) and
 * implements the one-shot CLI flow (`zcode-proxy claim [list|now]`).
 */
import type { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { PoolEntry } from "../pool/pool.js";
import type { ClaimablePlan, ClaimOutcome } from "./types.js";
import { createClaimClient, ClaimPreviewError } from "./client.js";
import { ClaimScheduler } from "./scheduler.js";
import { getCaptchaToken, solveCaptchaTokenViaProxy } from "../proxy/captcha.js";
import { loadCredentials } from "../auth/store.js";

/** `${process.platform}-${process.arch}` — mirrors the client's `TH()`. */
export function claimPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** What startAutoClaim returns: per-account scheduler fan, refreshable on membership changes. */
export interface AutoClaimRuntime {
  stop(): void;
  /** Re-resolve the account list after logins/logouts/removals. Surviving accounts keep their hold state. */
  refresh(): void;
}

/**
 * Auto-claim for EVERY pool account with a JWT — one independent
 * ClaimScheduler per account, so each account holds/claims on its own
 * (before: a single scheduler pinned to the pool pointer / first stored
 * credential, so with several OAuth accounts only one ever claimed).
 *
 * Per-account wiring is resolved LIVE from the pool snapshot at each tick:
 * the JWT, the log label, and above all the account's mihomo exit proxy —
 * claim traffic follows the same per-account exit IP as chat traffic (Bun's
 * per-request `proxy` fetch option). Ticks are STAGGERED (`staggerStepMs`
 * per account index): simultaneous ticks made every account launch a captcha
 * solve in the same instant, and the resulting burst of solve subprocesses
 * crashed children natively on worker-unstable hosts (observed 2026-10-07).
 * The stagger set at start persists — each scheduler keeps its own phase.
 */
export function startAutoClaim(
  config: ProxyConfig,
  auth: AuthManager,
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  staggerStepMs = 30_000,
): AutoClaimRuntime {
  const fetchBase = fetchImpl ?? globalThis.fetch;
  const schedulers = new Map<string, ClaimScheduler>();
  let halted = false;

  const findEntry = (id: string): PoolEntry | undefined =>
    auth.getPool()?.snapshotEntries().find((e) => e.id === id);

  const refresh = (): void => {
    if (halted) return;
    const before = schedulers.size;
    const live = new Map<string, PoolEntry>();
    for (const entry of auth.getPool()?.snapshotEntries() ?? []) {
      if (entry.credential.jwt) live.set(entry.id, entry);
    }
    for (const [id, scheduler] of schedulers) {
      if (!live.has(id)) {
        scheduler.stop();
        schedulers.delete(id);
      }
    }
    for (const [idx, id] of [...live.keys()].entries()) {
      if (schedulers.has(id)) continue;
      const scheduler = new ClaimScheduler({
        // Live lookup, NOT a captured credential: the pool may have rotated
        // proxies or refreshed the entry since this scheduler was built.
        getJwt: async () => findEntry(id)?.credential.jwt,
        createClient: (jwt) =>
          createClaimClient({
            origin: config.claim.origin,
            jwt,
            appVersion: config.identity.appVersion,
            platform: claimPlatform(),
            deviceMid: config.identity.deviceMid,
            fetchImpl: (url, init) => {
              const proxy = findEntry(id)?.proxyUrl;
              // Bun-only per-request option (same pattern as sendUpstreamRequest);
              // harmless extra key elsewhere.
              return fetchBase(url, (proxy ? { ...init, proxy } : init) as RequestInit & { proxy?: string });
            },
          }),
        getCaptcha: async () => {
          // Mint through the SAME exit the claim POST will use (live lookup):
          // a token minted direct but used from the account's exit IP is the
          // mint-IP ≠ use-IP mismatch risk control flags as "unusual
          // activity" (biz 3012). No exit / opted out → shared direct pool.
          const exit = findEntry(id)?.proxyUrl;
          const viaExit = exit && config.claim.captchaViaExit !== false;
          const { verifyParam, region } = viaExit
            ? await solveCaptchaTokenViaProxy(config.identity.appVersion, exit)
            : await getCaptchaToken(config.identity.appVersion);
          return { verifyParam, region: region || undefined };
        },
        config: {
          planId: config.claim.planId || undefined,
          pollIntervalMs: config.claim.pollIntervalMs,
          cooldownMs: config.claim.cooldownMs,
          initialDelayMs: idx * staggerStepMs,
        },
        log: (message) => {
          const label = findEntry(id)?.label ?? id;
          console.log(`[claim] ${label}: ${message.replace(/^claim: /, "")}`);
        },
      });
      scheduler.start();
      schedulers.set(id, scheduler);
    }
    if (schedulers.size !== before) {
      const names = (auth.getPool()?.snapshotEntries() ?? [])
        .filter((e) => e.credential.jwt)
        .map((e) => e.label)
        .join(", ");
      console.log(`[claim] fan now covers ${schedulers.size} account(s): ${names || "(none)"}`);
    }
  };

  const stop = (): void => {
    halted = true;
    for (const scheduler of schedulers.values()) scheduler.stop();
    schedulers.clear();
  };

  refresh();
  return { stop, refresh };
}

const FAILURE_LABELS: Record<string, string> = {
  not_found: "plan does not exist",
  unavailable: "campaign ended or not claimable yet",
  already_claimed: "already claimed on this account",
  ineligible: "account or client version not eligible (needs appVersion >= campaign minimum)",
  quota_exhausted: "daily claim quota exhausted",
  invalid_request: "invalid request",
  captcha: "captcha verification failed",
  login_required: "not logged in",
  http_error: "HTTP error",
  unknown: "unknown failure",
};

export interface ClaimCliOptions {
  /** Pause between accounts in `now` mode (default 30s — accounts must not claim as one burst). */
  gapMs?: number;
  /** DI seams for tests (defaults: globalThis.fetch / real captcha / real store). */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  getCaptcha?: (appVersion: string) => Promise<{ verifyParam: string; region: string }>;
  loadCreds?: () => Promise<Credential[]>;
}

/** `runClaimCli` result — `claimCommand` maps failed>0 to exit code 1. */
export interface ClaimCliResult {
  attempted: number;
  claimed: number;
  failed: number;
}

/**
 * One-shot CLI over EVERY stored OAuth account (used to be first-only):
 * `list` prints each account's previews; `now` claims the target plan per
 * account with a gap between accounts so five claims never hit the gateway
 * as one burst. Egress note: the CLI has no mihomo pool — preview, captcha
 * mint and claim all go DIRECT, so mint-IP == use-IP (no 3012 mismatch);
 * per-account exits are the serving fan's job (startAutoClaim).
 */
export async function runClaimCli(config: ProxyConfig, mode: "list" | "now", opts: ClaimCliOptions = {}): Promise<ClaimCliResult> {
  const gapMs = opts.gapMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const getCaptcha = opts.getCaptcha ?? getCaptchaToken;
  const loadCreds = opts.loadCreds ?? loadCredentials;

  const creds = (await loadCreds().catch(() => [] as Credential[])).filter((c) => c.jwt);
  if (creds.length === 0) {
    console.error("Claim requires a logged-in oauth credential (no JWT stored). Run: zcode-proxy auth login <zai|bigmodel>");
    return { attempted: 0, claimed: 0, failed: 1 };
  }

  const res: ClaimCliResult = { attempted: 0, claimed: 0, failed: 0 };
  for (const [i, cred] of creds.entries()) {
    const label = `${cred.provider}-oauth${i + 1}`;
    if (mode === "now" && i > 0) {
      console.log(`\nWaiting ${Math.round(gapMs / 1000)}s before the next account (claims stay spread) ...`);
      await new Promise((r) => setTimeout(r, gapMs));
    }
    console.log(`\n=== ${label} (${cred.provider}) ===`);
    const client = createClaimClient({
      origin: config.claim.origin,
      jwt: cred.jwt,
      appVersion: config.identity.appVersion,
      platform: claimPlatform(),
      deviceMid: config.identity.deviceMid,
      fetchImpl,
    });

    let plans: ClaimablePlan[];
    try {
      plans = await client.getPreviews();
    } catch (err) {
      if (err instanceof ClaimPreviewError && err.status === 404) {
        console.log("No claimable plans: the campaign endpoint is not deployed yet (404).");
        console.log("Weekend campaigns typically go live shortly before the window — keep the proxy");
        console.log("serving with claim.enabled, or re-run this command later.");
        continue;
      }
      console.error(`Preview failed: ${(err as Error).message}`);
      res.failed += 1;
      continue;
    }
    if (plans.length === 0) {
      console.log("No claimable plans right now.");
      continue;
    }
    printPlans(plans);
    if (mode === "list") continue;

    const wanted = config.claim.planId.trim();
    const target = wanted ? plans.find((p) => p.planId === wanted) : [...plans].sort((a, b) => b.priority - a.priority)[0];
    if (!target) {
      console.error(`Configured claim.planId "${wanted}" not in the preview list.`);
      res.failed += 1;
      continue;
    }
    if (target.planId !== plans[0].planId) console.log(`Claiming configured plan: ${target.planId}`);

    res.attempted += 1;
    const captcha = await getCaptcha(config.identity.appVersion);
    const outcome = await client.claim(target.planId, { verifyParam: captcha.verifyParam, region: captcha.region || undefined });
    printOutcome(outcome);
    if (outcome.ok) res.claimed += 1;
    else res.failed += 1;
  }
  if (mode === "now" && res.attempted > 0) {
    console.log(`\nClaim run: ${res.claimed} claimed, ${res.failed} failed, ${creds.length - res.attempted} with nothing to claim.`);
  }
  return res;
}

function printPlans(plans: ClaimablePlan[]): void {
  console.log(`Claimable plans (${plans.length}):`);
  for (const p of plans) {
    const window = [fmtTime(p.startsAt), fmtTime(p.endsAt)].filter(Boolean).join(" → ");
    console.log(`  - ${p.planId}  "${p.name}"  priority=${p.priority}${window ? `  ${window}` : ""}`);
    for (const e of p.entitlements) {
      const quota = e.grantUnits > 0 ? ` ${e.grantUnits} ${e.unitType}` : "";
      const activate = e.effectiveAt !== undefined ? ` (activates ${new Date(e.effectiveAt * 1000).toISOString()})` : "";
      console.log(`      · ${e.showName || e.entitlementId}${quota}${activate}`);
    }
  }
}

function printOutcome(outcome: ClaimOutcome): void {
  if (outcome.ok) {
    console.log(`\nClaimed: ${outcome.planId}`);
    if (outcome.startsAt !== undefined) console.log(`  activates: ${new Date(outcome.startsAt * 1000).toISOString()}`);
    if (outcome.endsAt !== undefined) console.log(`  expires:   ${new Date(outcome.endsAt * 1000).toISOString()}`);
    if (outcome.startsAt === undefined && outcome.endsAt === undefined) console.log("  active immediately");
    return;
  }
  const label = FAILURE_LABELS[outcome.failureKind] ?? FAILURE_LABELS.unknown;
  console.error(`\nClaim failed: ${label} (code ${String(outcome.code)}) — ${outcome.message}`);
  if (outcome.failureEndsAt !== undefined) {
    console.error(`  retry window opens: ${new Date(outcome.failureEndsAt * 1000).toISOString()}`);
  }
}

function fmtTime(sec: number | undefined): string {
  return sec === undefined ? "" : new Date(sec * 1000).toISOString();
}
