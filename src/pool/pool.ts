/**
 * Account pool — sequential (non-balanced) credential rotation with cooldown.
 *
 * Semantics (per feature spec):
 *  - `acquire()` always returns the entry at the pointer: a healthy account is
 *    used until it breaks, never load-balanced across.
 *  - Upstream key-class failures (429/401/403 only) count per entry as
 *    "strikes". At `failureThreshold` consecutive strikes the entry cools down
 *    and the pointer advances to the next live entry.
 *  - When EVERY entry is cooling, all entries revive and the pointer restarts
 *    at the head — no timers; revival happens lazily on the next acquire.
 */
import type { ProviderId } from "../provider/types.js";
import type { Credential } from "../auth/types.js";

/** One account in the pool. */
export interface PoolEntry {
  /** Stable id: `cfg:<label>` for config accounts, `oauth:<provider>:<key>` for store logins. */
  id: string;
  label: string;
  provider: ProviderId;
  /** `config` = plaintext api-key from config.yaml; `oauth` = login-store credential. */
  source: "config" | "oauth";
  credential: Credential;
  /** Resolved plan tier for this account (per-account override, else the build-time default). */
  plan: "coding-plan" | "start-plan";
  /** Explicit exit-node label override; absent = auto round-robin binding. */
  proxy?: string;
  /** Local mihomo listener this entry's upstream traffic is bound to, e.g. `http://127.0.0.1:47000`. */
  proxyUrl?: string;
  /** Human label of the bound proxy node (from the Clash node `name`). */
  proxyLabel?: string;
}

/** Wire-safe per-entry status (never includes the credential). */
export interface PoolStatusEntry {
  id: string;
  label: string;
  provider: string;
  source: "config" | "oauth";
  plan: string;
  /** Explicit exit-node override label, when one is set. */
  proxy?: string;
  proxyLabel?: string;
  proxyUrl?: string;
  strikes: number;
  cooling: boolean;
  /** True when this entry is the one `acquire()` currently returns. */
  current: boolean;
}

interface EntryState {
  strikes: number;
  cooling: boolean;
}

export interface AccountPoolOptions {
  /** Consecutive key-class failures before an entry cools down. Default 10. */
  failureThreshold?: number;
  /**
   * Local proxy endpoints (mihomo listeners, in node order). Entry i binds to
   * `proxyUrls[i % proxyUrls.length]`; empty list = all direct.
   */
  proxyUrls?: string[];
  proxyLabels?: string[];
  /** Plan tier for entries without a per-account override (the global `config.plan`). */
  defaultPlan?: "coding-plan" | "start-plan";
  /** Rotation event sink (defaults to console.log with a `[pool]` prefix). */
  onEvent?: (message: string) => void;
}

export const DEFAULT_FAILURE_THRESHOLD = 10;

/** Build a pool entry from a config.yaml account. */
export function configAccountEntry(
  account: { label?: string; provider: ProviderId; apiKey: string; secret?: string; plan?: "coding-plan" | "start-plan"; proxy?: string },
  index: number,
): PoolEntry {
  const label = account.label?.trim() || `${account.provider}-${index + 1}`;
  return {
    id: `cfg:${label}`,
    label,
    provider: account.provider,
    source: "config",
    credential: {
      apiKey: account.apiKey,
      ...(account.secret ? { secret: account.secret } : {}),
      provider: account.provider,
    },
    // Manual keys are coding-plan keys by contract; `plan:` exists for exotic cases.
    plan: account.plan ?? "coding-plan",
    ...(account.proxy ? { proxy: account.proxy } : {}),
  };
}

/** Build a pool entry from a login-store credential. */
export function oauthAccountEntry(
  cred: Credential,
  position: number,
  defaultPlan: "coding-plan" | "start-plan" = "coding-plan",
): PoolEntry {
  return {
    id: `oauth:${cred.provider}:${cred.apiKey}`,
    label: `${cred.provider}-oauth${position + 1}`,
    provider: cred.provider,
    source: "oauth",
    credential: cred,
    plan: cred.plan ?? defaultPlan,
    ...(cred.proxy ? { proxy: cred.proxy } : {}),
  };
}

export class AccountPool {
  private entries: PoolEntry[];
  private states = new Map<string, EntryState>();
  private pointer = 0;
  readonly failureThreshold: number;
  private readonly proxyUrls: string[];
  private readonly proxyLabels: string[];
  private readonly defaultPlan: "coding-plan" | "start-plan";
  private readonly onEvent: (message: string) => void;

  constructor(entries: PoolEntry[], opts: AccountPoolOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.proxyUrls = opts.proxyUrls ?? [];
    this.proxyLabels = opts.proxyLabels ?? [];
    this.defaultPlan = opts.defaultPlan ?? "coding-plan";
    this.onEvent = opts.onEvent ?? ((m) => console.log(`[pool] ${m}`));
    this.entries = [];
    for (const entry of entries) this.addEntry(entry);
  }

  get size(): number {
    return this.entries.length;
  }

  /** All exit-node endpoints (mihomo listeners) in node order — the candidate list for exit auto-rotation (claim fan). */
  exitTargets(): Array<{ label: string; url: string }> {
    return this.proxyUrls.map((url, i) => ({ label: this.proxyLabels[i] ?? url, url }));
  }

  /**
   * Replace the oauth-sourced entries (config entries and their state are
   * kept). States of surviving ids persist; removed ids are dropped; the
   * pointer is re-clamped. Proxy bindings are re-assigned to the new order.
   */
  setOAuthCredentials(creds: Credential[]): void {
    const configEntries = this.entries.filter((e) => e.source === "config");
    const oauthEntries = creds.map((cred, i) => oauthAccountEntry(cred, i, this.defaultPlan));
    this.entries = [...configEntries, ...oauthEntries];
    for (const id of [...this.states.keys()]) {
      if (!this.entries.some((e) => e.id === id)) this.states.delete(id);
    }
    for (let i = 0; i < this.entries.length; i++) this.assignProxy(this.entries[i], i);
    if (this.pointer >= this.entries.length) this.pointer = 0;
    this.onEvent(`oauth accounts updated — pool now holds ${this.entries.length}`);
  }

  /** Current entry (sequential, non-balanced). Revives all when every entry is cooling. */
  acquire(): PoolEntry {
    if (this.entries.length === 0) throw new Error("account pool is empty");
    if (this.stateOf(this.entries[this.pointer]).cooling) this.advance(this.pointer);
    return this.entries[this.pointer];
  }

  /** Any usable (non-key-class) upstream outcome resets the consecutive-failure chain. */
  reportSuccess(entry: PoolEntry): void {
    this.stateOf(entry).strikes = 0;
  }

  /**
   * Count one key-class failure (429/401/403). Returns true when this failure
   * cooled the entry down and the pool moved on.
   */
  reportFailure(entry: PoolEntry): boolean {
    const s = this.stateOf(entry);
    s.strikes += 1;
    if (s.cooling || s.strikes < this.failureThreshold) return false;
    s.cooling = true;
    const idx = this.entries.indexOf(entry);
    this.onEvent(
      `${entry.label} cooled down after ${s.strikes} consecutive key errors — switching to ${this.nextLiveLabel(idx)}`,
    );
    if (idx === this.pointer) this.advance(idx);
    return true;
  }

  /**
   * Definitive budget exhaustion (upstream biz 1005 quota / 1113 balance,
   * hidden behind HTTP 200 or 429): cool the entry at once instead of burning
   * `failureThreshold` requests on an account that cannot serve until the
   * reset. Revives lazily via the existing all-cooling rule — no cooldown
   * timer, per the rotation spec.
   */
  reportQuotaExhausted(entry: PoolEntry): boolean {
    const s = this.stateOf(entry);
    if (s.cooling) return true;
    s.cooling = true;
    s.strikes = 0;
    const idx = this.entries.indexOf(entry);
    this.onEvent(
      `${entry.label} quota/balance exhausted (upstream) — cooling until reset, switching to ${this.nextLiveLabel(idx)}`,
    );
    if (idx === this.pointer) this.advance(idx);
    return true;
  }

  /** Live wire-safe snapshot for UIs. */
  status(): PoolStatusEntry[] {
    return this.entries.map((e, i) => {
      const s = this.stateOf(e);
      return {
        id: e.id,
        label: e.label,
        provider: e.provider,
        source: e.source,
        plan: e.plan,
        ...(e.proxy ? { proxy: e.proxy } : {}),
        ...(e.proxyLabel ? { proxyLabel: e.proxyLabel } : {}),
        ...(e.proxyUrl ? { proxyUrl: e.proxyUrl } : {}),
        strikes: s.strikes,
        cooling: s.cooling,
        current: i === this.pointer,
      };
    });
  }

  /** Entries with credentials for quota collection (in-process only). */
  snapshotEntries(): PoolEntry[] {
    return [...this.entries];
  }

  private addEntry(entry: PoolEntry): void {
    this.entries.push(entry);
    this.assignProxy(entry, this.entries.length - 1);
  }

  private assignProxy(entry: PoolEntry, index: number): void {
    if (this.proxyUrls.length === 0) {
      delete entry.proxyUrl;
      delete entry.proxyLabel;
      return;
    }
    // Explicit node pin wins when it names a known node; otherwise auto round-robin.
    let i = -1;
    if (entry.proxy) i = this.proxyLabels.indexOf(entry.proxy);
    if (i < 0) i = index % this.proxyUrls.length;
    entry.proxyUrl = this.proxyUrls[i];
    entry.proxyLabel = this.proxyLabels[i];
  }

  private nextLiveLabel(from: number): string {
    const n = this.entries.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (!this.stateOf(this.entries[idx]).cooling) return this.entries[idx].label;
    }
    return `${this.entries[0].label} (all cooling — will revive)`;
  }

  private advance(from: number): void {
    const n = this.entries.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (!this.stateOf(this.entries[idx]).cooling) {
        this.pointer = idx;
        return;
      }
    }
    // Every entry is cooling — revive all and restart from the head.
    for (const e of this.entries) {
      const s = this.stateOf(e);
      s.cooling = false;
      s.strikes = 0;
    }
    this.pointer = 0;
    this.onEvent(`all ${n} accounts cooling — reviving all, restarting from ${this.entries[0].label}`);
  }

  private stateOf(entry: PoolEntry): EntryState {
    let s = this.states.get(entry.id);
    if (!s) {
      s = { strikes: 0, cooling: false };
      this.states.set(entry.id, s);
    }
    return s;
  }
}

/**
 * Assemble the pool from config accounts + oauth store credentials, wiring
 * proxy bindings and the failure threshold. Returns null when there is
 * nothing to pool (callers fall back to the legacy single-credential path).
 */
export function buildAccountPool(
  accounts: { label?: string; provider: ProviderId; apiKey: string; secret?: string; plan?: "coding-plan" | "start-plan"; proxy?: string }[],
  oauthCreds: Credential[],
  opts: AccountPoolOptions = {},
): AccountPool | null {
  const entries = accounts.map((a, i) => configAccountEntry(a, i));
  const perProvider = new Map<string, number>();
  for (const cred of oauthCreds) {
    const pos = perProvider.get(cred.provider) ?? 0;
    perProvider.set(cred.provider, pos + 1);
    entries.push(oauthAccountEntry(cred, pos, opts.defaultPlan));
  }
  const pool = new AccountPool(entries, opts);
  if (pool.size === 0) return null;
  return pool;
}
