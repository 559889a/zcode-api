/**
 * AccountPool state machine tests — sequential rotation, cooldown at the
 * failure threshold, all-cooling revival, and proxy binding. No sleeps: the
 * pool has no timers by design (revival is lazy on acquire).
 */
import { describe, it, expect } from "bun:test";
import { AccountPool, buildAccountPool, configAccountEntry, oauthAccountEntry, DEFAULT_FAILURE_THRESHOLD } from "./pool.js";
import type { PoolEntry } from "./pool.js";
import type { Credential } from "../auth/types.js";

function entry(label: string, provider: "zai" | "bigmodel" = "zai"): PoolEntry {
  return configAccountEntry({ label, provider, apiKey: `key-${label}` }, 0);
}

function makePool(labels: string[], threshold = 10): { pool: AccountPool; entries: PoolEntry[] } {
  const entries = labels.map((l) => entry(l));
  return { pool: new AccountPool(entries, { failureThreshold: threshold, onEvent: () => {} }), entries };
}

describe("AccountPool — sequential (non-balanced) rotation", () => {
  it("keeps returning the same entry while it is healthy", () => {
    const { pool, entries } = makePool(["a", "b", "c"]);
    for (let i = 0; i < 5; i++) {
      expect(pool.acquire()).toBe(entries[0]);
    }
  });

  it("reports the default failure threshold of 10", () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(10);
    const { pool } = makePool(["a"]);
    expect(pool.failureThreshold).toBe(10);
  });
});

describe("AccountPool — cooldown", () => {
  it("does not advance below the threshold; advances exactly at it", () => {
    const { pool, entries } = makePool(["a", "b"], 3);
    expect(pool.reportFailure(entries[0])).toBe(false);
    expect(pool.reportFailure(entries[0])).toBe(false);
    expect(pool.acquire()).toBe(entries[0]); // still on a
    expect(pool.reportFailure(entries[0])).toBe(true); // third strike → cooled, pointer moved
    expect(pool.acquire()).toBe(entries[1]);
  });

  it("quota exhaustion (biz 1005) cools immediately — one report, pointer moved, no strike ladder", () => {
    const { pool, entries } = makePool(["a", "b"], 10);
    expect(pool.reportQuotaExhausted(entries[0])).toBe(true);
    expect(pool.acquire()).toBe(entries[1]); // a is out right away
    const st = pool.status();
    expect(st[0].cooling).toBe(true);
    expect(st[0].strikes).toBe(0); // not a strike-ladder outcome
    expect(st[1].current).toBe(true);
  });

  it("quota exhaustion is idempotent on an already-cooling entry", () => {
    const { pool, entries } = makePool(["a", "b", "c"]);
    pool.reportQuotaExhausted(entries[0]);
    expect(pool.reportQuotaExhausted(entries[0])).toBe(true);
    expect(pool.acquire()).toBe(entries[1]); // pointer did not move twice
  });

  it("resumes the cooldown ladder from where a revived entry left off is reset (success clears strikes)", () => {
    const { pool, entries } = makePool(["a"], 3);
    pool.reportFailure(entries[0]);
    pool.reportFailure(entries[0]); // would cool — but a success in between resets
    pool.reportSuccess(entries[0]);
    pool.reportFailure(entries[0]);
    expect(pool.status()[0].cooling).toBe(false);
    expect(pool.status()[0].strikes).toBe(1);
  });

  it("revives all entries and restarts from the head when every entry is cooling", () => {
    const { pool, entries } = makePool(["a", "b", "c"], 2);
    for (const e of entries) {
      pool.reportFailure(e);
      pool.reportFailure(e);
    }
    // Everything cooled — the next acquire revives all and starts at the head.
    expect(pool.acquire()).toBe(entries[0]);
    expect(pool.status().every((s) => !s.cooling && s.strikes === 0)).toBe(true);
  });

  it("revives all immediately once the last live entry cools (exhaustion = revival)", () => {
    const { pool, entries } = makePool(["a", "b"], 1);
    pool.reportFailure(entries[0]); // a cools, pointer → b
    pool.reportFailure(entries[1]); // b cools → nothing left → revive all at once
    expect(pool.status().every((s) => !s.cooling && s.strikes === 0)).toBe(true);
    expect(pool.acquire()).toBe(entries[0]);
  });

  it("skips cooling entries when advancing", () => {
    const { pool, entries } = makePool(["a", "b", "c"], 1);
    pool.reportFailure(entries[0]); // a cools → b
    expect(pool.acquire()).toBe(entries[1]);
    pool.reportFailure(entries[1]); // b cools → c
    expect(pool.acquire()).toBe(entries[2]);
  });
});

describe("AccountPool — oauth entry management", () => {
  it("replaces oauth entries and keeps config entries + their state", () => {
    const cfg = entry("cfg-1");
    const oa = oauthAccountEntry({ apiKey: "oa-1", provider: "zai" }, 0);
    const pool = new AccountPool([cfg, oa], { failureThreshold: 2, onEvent: () => {} });
    pool.reportFailure(oa);
    pool.setOAuthCredentials([{ apiKey: "oa-2", provider: "zai" }]);
    const status = pool.status();
    expect(status.map((s) => s.label)).toEqual(["cfg-1", "zai-oauth1"]);
    expect(status[0].strikes).toBe(0); // untouched
    expect(status[1].strikes).toBe(0); // new entry starts clean
  });

  it("drops the state of removed oauth ids", () => {
    const oa1 = oauthAccountEntry({ apiKey: "oa-1", provider: "zai" }, 0);
    const oa2 = oauthAccountEntry({ apiKey: "oa-2", provider: "zai" }, 1);
    const pool = new AccountPool([oa1, oa2], { failureThreshold: 2, onEvent: () => {} });
    pool.reportFailure(oa1);
    pool.reportFailure(oa1); // oa1 cooled, pointer moved to oa2
    pool.setOAuthCredentials([{ apiKey: "oa-2", provider: "zai" }]);
    expect(pool.acquire().credential.apiKey).toBe("oa-2");
    expect(pool.status().every((s) => !s.cooling)).toBe(true);
  });
});

describe("AccountPool — proxy binding", () => {
  it("binds entry i to node i mod n and re-binds after oauth updates", () => {
    const pool = new AccountPool([entry("a"), entry("b"), entry("c")], {
      proxyUrls: ["http://127.0.0.1:47000", "http://127.0.0.1:47001"],
      proxyLabels: ["node-jp", "node-sg"],
      onEvent: () => {},
    });
    const [a, b, c] = pool.status();
    expect(a.proxyUrl).toBe("http://127.0.0.1:47000");
    expect(b.proxyUrl).toBe("http://127.0.0.1:47001");
    expect(c.proxyUrl).toBe("http://127.0.0.1:47000"); // wraps
    expect(c.proxyLabel).toBe("node-jp");
  });

  it("leaves entries direct when no proxy urls are given", () => {
    const { pool } = makePool(["a"]);
    expect(pool.status()[0].proxyUrl).toBeUndefined();
  });
});

describe("AccountPool — per-account plan and node overrides", () => {
  const cred = (apiKey: string, extra: Partial<Credential> = {}): Credential => ({ apiKey, provider: "zai", ...extra });

  it("oauth entries default to the build-time defaultPlan and honor per-credential overrides", () => {
    const pool = new AccountPool(
      [oauthAccountEntry(cred("k1"), 0, "start-plan"), oauthAccountEntry(cred("k2", { plan: "coding-plan" }), 1, "start-plan")],
      { onEvent: () => {} },
    );
    const [a, b] = pool.status();
    expect(a.plan).toBe("start-plan"); // followed the default
    expect(b.plan).toBe("coding-plan"); // per-credential override won
  });

  it("setOAuthCredentials re-applies overrides from the stored credentials", () => {
    const pool = new AccountPool([entry("cfg-1")], { defaultPlan: "start-plan", onEvent: () => {} });
    pool.setOAuthCredentials([cred("k1", { plan: "coding-plan", proxy: "node-sg" })]);
    const s = pool.status()[1];
    expect(s.plan).toBe("coding-plan");
    expect(s.proxy).toBe("node-sg");
  });

  it("an explicit node pin wins over the round-robin slot; unknown labels fall back to auto", () => {
    const pool = new AccountPool(
      [configAccountEntry({ label: "pinned", provider: "zai", apiKey: "k", proxy: "node-sg" }, 0), configAccountEntry({ label: "ghost", provider: "zai", apiKey: "k2", proxy: "nope" }, 1)],
      {
        proxyUrls: ["http://127.0.0.1:47000", "http://127.0.0.1:47001"],
        proxyLabels: ["node-jp", "node-sg"],
        onEvent: () => {},
      },
    );
    const [pinned, ghost] = pool.status();
    expect(pinned.proxyUrl).toBe("http://127.0.0.1:47001"); // pinned to node-sg despite slot 0
    expect(ghost.proxyUrl).toBe("http://127.0.0.1:47001"); // unknown pin → auto slot 1
  });

  it("config accounts carry their plan field, defaulting to coding-plan", () => {
    const pool = buildAccountPool(
      [{ label: "sp", provider: "bigmodel", apiKey: "k", plan: "start-plan" }, { label: "cp", provider: "bigmodel", apiKey: "k2" }],
      [],
      { defaultPlan: "start-plan", onEvent: () => {} },
    )!;
    const [sp, cp] = pool.status();
    expect(sp.plan).toBe("start-plan");
    expect(cp.plan).toBe("coding-plan");
  });
});

describe("buildAccountPool", () => {
  const cred = (apiKey: string, provider: Credential["provider"]): Credential => ({ apiKey, provider });

  it("returns null when there is nothing to pool", () => {
    expect(buildAccountPool([], [])).toBeNull();
  });

  it("merges config accounts first, then oauth logins, numbering oauth labels per provider", () => {
    const pool = buildAccountPool(
      [{ label: "bm-1", provider: "bigmodel", apiKey: "bm-key" }],
      [cred("zai-key-1", "zai"), cred("zai-key-2", "zai"), cred("bm-key-2", "bigmodel")],
      { onEvent: () => {} },
    )!;
    expect(pool.status().map((s) => s.label)).toEqual(["bm-1", "zai-oauth1", "zai-oauth2", "bigmodel-oauth1"]);
  });

  it("wires per-entry credentials from config accounts (secret → zai credential string form)", () => {
    const pool = buildAccountPool([{ label: "z", provider: "zai", apiKey: "id", secret: "sec" }], [], { onEvent: () => {} })!;
    expect(pool.acquire().credential).toEqual({ apiKey: "id", secret: "sec", provider: "zai" });
  });
});
