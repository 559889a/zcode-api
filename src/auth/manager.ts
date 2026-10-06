/**
 * Auth manager — resolves the upstream credential to inject into proxied
 * requests.
 *
 * Two modes:
 *  - Pool mode: an {@link AccountPool} is attached (any credential source
 *    exists) — `getCredential()` returns the pool's current entry (sequential
 *    rotation with cooldown; see pool.ts).
 *  - Legacy single mode: one credential set via {@link setOAuthCredential},
 *    kept for embedders/tests that never build a pool.
 *
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { Credential } from "./types.js";
import type { AccountPool } from "../pool/pool.js";

export class AuthManager {
  private oauthCred: Credential | null = null;
  private pool: AccountPool | null = null;

  /** Attach (or detach) the account pool. When set and non-empty it drives `getCredential()`. */
  setPool(pool: AccountPool | null): void {
    this.pool = pool;
  }

  getPool(): AccountPool | null {
    return this.pool;
  }

  /**
   * Returns the current credential or throws when none is stored.
   *
   * There is no proactive refresh: the login flows never populate
   * `expiresAt`, so expiry surfaces as an upstream 401, not here. The guard
   * below is retained for the day a flow starts filling `expiresAt`.
   */
  async getCredential(): Promise<Credential> {
    if (this.pool && this.pool.size > 0) {
      return this.pool.acquire().credential;
    }
    if (this.oauthCred) {
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        this.oauthCred = null;
        throw new Error("OAuth credential expired; re-authentication required — run: zcode-proxy auth login");
      }
      return this.oauthCred;
    }
    throw new Error("OAuth credential not available — run: zcode-proxy auth login");
  }

  /** Replace the whole oauth account list (pool mode keeps config accounts). */
  setOAuthCredentials(creds: Credential[]): void {
    this.oauthCred = creds[0] ?? null;
    this.pool?.setOAuthCredentials(creds);
  }

  /** Set the OAuth credential (used by the `auth login` flow). */
  setOAuthCredential(cred: Credential): void {
    this.setOAuthCredentials([cred]);
  }

  /**
   * Drop the in-memory credential without touching the store.
   *
   * Used when the user logs out while the process keeps running (the `serve`
   * web panel): this manager is consulted before the store, so a credential
   * that is already gone from disk would otherwise keep being spent by `/v1`
   * requests and by auto-claim.
   */
  clearOAuthCredential(): void {
    this.setOAuthCredentials([]);
  }
}
