/**
 * captcha-worker-dispatch.ts — solve execution: worker thread with an
 * in-process fallback.
 *
 * Each solve runs in its own worker_threads Worker so the proxy's main event
 * loop never blocks on the solver's Atomics.wait sync XHRs — in-process
 * solving froze every connection during refill bursts (issue #54, PR #55).
 * Worker-per-solve also isolates happy-dom's global browser-frame/cookie
 * state per solve, removing cross-solve races.
 *
 * `ZCODE_CAPTCHA_WORKER=off` switches the execution backend to a child
 * process (fork of the same entry bundle, same protocol) for machines where
 * worker threads crash natively mid-solve — a worker crash kills the whole
 * process and cannot be caught, while a child's death is a catchable event
 * that fails only that solve (the pool retries a fresh child; there is
 * deliberately NO in-process fallback in off mode — see solveViaWorkerOrInProcess).
 *
 * The worker entry is a build-time FILE ASSET (captcha-worker-asset.ts —
 * `bun build --compile` cannot resolve `new Worker(new URL(...))` at
 * runtime). Resolution here is dynamic and may legitimately fail: the asset
 * exists only after scripts/build-fork-worker.ts runs, and the esbuild
 * Android bundle marks the asset module external. On such deployments we
 * solve IN-PROCESS instead (the pre-worker behavior, still bounded by the
 * CAPTCHA_SYNC_FETCH_TIMEOUT_MS / CAPTCHA_SOLVE_TIMEOUT_MS caps). Mode
 * transitions are announced once on stderr for operators.
 */
import { Worker } from "node:worker_threads";
import { fork, type ChildProcess } from "node:child_process";

/** Per-solve timeout: overall deadline the worker gets before termination. */
const SOLVE_WORKER_TIMEOUT_MS = Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS || 20_000);

// ponytail: ceiling — one forked Bun child costs ~0.3-0.4GB commit and crashes
// natively at a small rate on worker-unstable hosts; the token pool's 3-lane
// waves + empty-take race can otherwise stack 6+ children at once and exhaust
// commit on small hosts (observed 2026-10-07, 8GB RAM → JSC MemoryExhaustion
// assertions in the children). Cap concurrent children; queued solves wait in
// FIFO order and are still bounded by the per-solve timeout above. Upgrade
// path: one persistent sequential-solve child per exit (amortizes the ~1s
// spawn). Override: CAPTCHA_CHILD_MAX_CONCURRENT.
const MAX_CONCURRENT_CHILDREN = Math.max(1, Number(process.env.CAPTCHA_CHILD_MAX_CONCURRENT || 2));
let activeChildren = 0;
const childQueue: Array<() => void> = [];

/** Test-only: child-backend semaphore state (concurrency assertions). */
export function __captchaChildSlotsForTest(): { active: number; queued: number; max: number } {
  return { active: activeChildren, queued: childQueue.length, max: MAX_CONCURRENT_CHILDREN };
}

interface SolveRequest {
  id: number;
  scene: string;
  region: string;
  prefix: string;
  /**
   * Optional per-solve egress proxy (claim-plane minting through the
   * account's exit) — the token's mint IP then matches the IP it is used
   * from. Absent = direct (chat-plane shared-pool behavior, unchanged).
   */
  proxyUrl?: string;
}
type SolveResponse = { id: number; ok: true; param: string } | { id: number; ok: false; error: string };

let nextSolveId = 0;

// Lazy-loaded in-process solver — imported only on the fallback path so
// processes that never solve (coding-plan) never pay the happy-dom startup.
type InProcessSolveFn = (opts: {
  scene: string;
  region: string;
  prefix: string;
  proxyUrl?: string;
}) => Promise<string>;
let inProcessOverride: InProcessSolveFn | null = null;
let happyMod: { solveTraceless: InProcessSolveFn } | null = null;
async function happy(): Promise<{ solveTraceless: InProcessSolveFn }> {
  if (inProcessOverride) return { solveTraceless: inProcessOverride };
  if (!happyMod) {
    happyMod = (await import("./captcha-happy.js")) as { solveTraceless: InProcessSolveFn };
  }
  return happyMod;
}

let entryPathCache: string | null | undefined;
let lastNotedMode = "";

/** Announce solve-mode TRANSITIONS only (worker <-> in-process), once each. */
function noteMode(mode: string, line: string): void {
  if (mode === lastNotedMode) return;
  lastNotedMode = mode;
  try { process.stderr.write(line); } catch {}
}

/**
 * Worker escape hatch: `ZCODE_CAPTCHA_WORKER=off` swaps the execution
 * backend from a worker_threads Worker to a child_process fork running the
 * SAME entry bundle. For machines where worker threads crash NATIVELY
 * mid-solve (observed on a no-AVX2 CPU, 2026-10-06): a worker crash cannot
 * be caught — it kills the whole process — while a child's death is a
 * catchable event, so the fork backend degrades to in-process solving
 * instead of taking the proxy down. Evaluated per call (store.ts
 * precedent). `ponytail:` ceiling — a fork is a full Bun process (~10× a
 * thread's footprint) and pool lanes are concurrent, but solves are
 * short-lived and bounded (≤3 lanes); upgrade path is a fixed Bun runtime.
 */
function workerDisabledByEnv(): boolean {
  return /^(off|false|0|no|child|fork)$/i.test((process.env.ZCODE_CAPTCHA_WORKER ?? "").trim());
}

/**
 * Resolve the pre-bundled worker entry (build-time file asset). Cached
 * because a miss is permanent for the process lifetime: the bundle is a
 * build input that cannot appear while running. Never throws.
 */
async function getWorkerEntryPath(): Promise<string | null> {
  if (entryPathCache !== undefined) return entryPathCache;
  try {
    const m = await import("./captcha-worker-asset.js");
    const p = (m as { default?: unknown }).default;
    entryPathCache = typeof p === "string" && p ? p : null;
  } catch {
    entryPathCache = null;
  }
  if (entryPathCache && !workerDisabledByEnv()) {
    noteMode("worker", "[captcha-solver] worker-thread solving active\n");
  } else if (!entryPathCache) {
    noteMode(
      "in-process",
      "[captcha-solver] worker entry unavailable — solving in-process " +
        "(run scripts/build-fork-worker.ts / bun run build to embed workers)\n",
    );
  }
  return entryPathCache;
}

/** Worker-entry unusable — the only worker failure that falls back. */
class WorkerUnavailableError extends Error {}

/** Child-process unusable (spawn failure / crash before answering) — falls back. */
class ChildUnavailableError extends Error {}

/** Load-stage failures (entry missing/unloadable); runtime crashes do NOT match. */
function isEntryUnavailableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" ||
    // Node's text ("Cannot find module") and Bun's loader BuildMessage
    // ("ModuleNotFound resolving "<path>" (entry point)") — the latter is
    // camelCase with no spaces and carries no code (observed on Windows,
    // where the short path resolves but the loader still rejects it).
    /cannot find module|module not found|modulenotfound/i.test(String(e?.message ?? ""))
  );
}

export async function solveViaWorkerOrInProcess(req: {
  scene: string;
  region: string;
  prefix: string;
  proxyUrl?: string;
}): Promise<string> {
  const entryPath = await getWorkerEntryPath();
  if (workerDisabledByEnv()) {
    // Child-process backend: same entry bundle, full process, catchable death.
    // No in-process fallback here, deliberately: in-process solving runs
    // captcha-happy on the MAIN thread, whose sync-XHR helper spawns its own
    // worker_threads Worker (captcha-happy.ts syncFetchBlocking) — on the very
    // machines that need `off`, that re-introduces the uncatchable native
    // worker crash the switch exists to avoid (plus 12s event-loop stalls).
    // A dead child fails the solve; the pool's retry ladder rolls a fresh one.
    if (entryPath === null) {
      const msg =
        "captcha worker entry unavailable and ZCODE_CAPTCHA_WORKER=off — " +
        "run scripts/build-fork-worker.ts / bun run build to (re)generate it " +
        "(in-process solving is disabled by the off switch)";
      noteMode("off-no-entry", `[captcha-solver] ${msg}\n`);
      throw new Error(msg);
    }
    noteMode("child", `[captcha-solver] ZCODE_CAPTCHA_WORKER=off — solving in a child process (max ${MAX_CONCURRENT_CHILDREN} concurrent)\n`);
    try {
      return await solveInChildProcess(entryPath, req);
    } catch (err) {
      if (err instanceof ChildUnavailableError) {
        throw new Error(
          `${err.message} (ZCODE_CAPTCHA_WORKER=off: no in-process fallback — the pool retries a fresh child)`,
        );
      }
      throw err; // real solve failure (timeout / solver error) — pool retries
    }
  }
  if (entryPath === null) {
    return (await happy()).solveTraceless(req);
  }
  try {
    return await solveInWorker(entryPath, req);
  } catch (err) {
    if (err instanceof WorkerUnavailableError) {
      return (await happy()).solveTraceless(req);
    }
    throw err;
  }
}

/**
 * One solve = one Worker. Startup cost is a few ms (happy-dom loads lazily
 * inside the entry on first message); termination guarantees no state leaks
 * between solves. A hung solve cannot wedge anything: the pool's takeToken
 * race deadline (25s) fires first, and the worker is force-terminated here.
 */
function solveInWorker(
  entryPath: string,
  req: { scene: string; region: string; prefix: string; proxyUrl?: string },
): Promise<string> {
  const id = ++nextSolveId;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let worker: Worker | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker?.terminate(); } catch {}
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`captcha worker timeout (${SOLVE_WORKER_TIMEOUT_MS}ms)`)));
    }, SOLVE_WORKER_TIMEOUT_MS);

    try {
      worker = new Worker(entryPath);
    } catch (err) {
      const msg = `captcha worker spawn failed: ${(err as Error).message}`;
      noteMode("in-process", `[captcha-solver] ${msg} — degrading to in-process solving\n`);
      settle(() => reject(new WorkerUnavailableError(msg)));
      return;
    }
    const msg: SolveRequest = { id, ...req };
    worker.on("message", (m: SolveResponse) => {
      if (!m || m.id !== id) return;
      if (m.ok) settle(() => resolve(m.param));
      else settle(() => reject(new Error(m.error)));
    });
    worker.on("error", (err: Error) => {
      // A load-stage failure (entry unloadable) means workers are unusable in
      // this deployment — degrade. Anything else (crash/OOM inside a loaded
      // worker) stays a hard failure: retrying it on the MAIN thread is the
      // #54/#50 failure shape, and the pool's retry ladder rolls a fresh
      // worker instead.
      if (isEntryUnavailableError(err)) {
        noteMode(
          "in-process",
          `[captcha-solver] captcha worker entry failed to load: ${err.message} — degrading to in-process solving\n`,
        );
        settle(() => reject(new WorkerUnavailableError(`captcha worker entry failed to load: ${err.message}`)));
      } else {
        settle(() => reject(new Error(`captcha worker error: ${err.message}`)));
      }
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !settled) {
        settle(() => reject(new Error(`captcha worker exited (code ${code}) before solving`)));
      } else if (!settled) {
        settle(() => reject(new Error("captcha worker exited before responding")));
      }
    });
    worker.postMessage(msg);
  });
}

/**
 * One solve = one child process (fork of the same entry bundle). Semantics
 * mirror solveInWorker — fresh execution per solve, forced kill on timeout.
 * A child dying mid-solve is a catchable event: the solve fails and the
 * CALLER's retry ladder (token pool, or the claim scheduler's cooldown)
 * decides whether to roll a fresh one — there is deliberately no in-process
 * fallback here (see solveViaWorkerOrInProcess). Children are capped at
 * MAX_CONCURRENT_CHILDREN; extra solves queue behind the semaphore.
 */
function solveInChildProcess(
  entryPath: string,
  req: { scene: string; region: string; prefix: string; proxyUrl?: string },
): Promise<string> {
  const id = ++nextSolveId;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let child: ChildProcess | null = null;
    let slotHeld = false;
    const releaseSlot = (): void => {
      if (!slotHeld) return;
      slotHeld = false;
      activeChildren -= 1;
      childQueue.shift()?.();
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      releaseSlot();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`captcha child process timeout (${SOLVE_WORKER_TIMEOUT_MS}ms)`)));
    }, SOLVE_WORKER_TIMEOUT_MS);

    const spawnSolve = (): void => {
      if (settled) {
        // Timed out while queued for a slot — pass the slot on immediately.
        releaseSlot();
        return;
      }
      try {
        // silent: the child's stderr (15-line Bun native-crash banners) is
        // dropped instead of flooding the operator console; its death is
        // still reported compactly through the exit event below.
        child = fork(entryPath, [], { silent: true });
      } catch (err) {
        settle(() => reject(new ChildUnavailableError(`captcha child process spawn failed: ${(err as Error).message}`)));
        return;
      }
      child.on("message", (m: SolveResponse) => {
        if (!m || m.id !== id) return;
        if (m.ok) settle(() => resolve(m.param));
        else settle(() => reject(new Error(m.error)));
      });
      child.on("error", (err: Error) => {
        settle(() => reject(new ChildUnavailableError(`captcha child process error: ${err.message}`)));
      });
      child.on("exit", (code) => {
        if (!settled) {
          settle(() => reject(new ChildUnavailableError(`captcha child process exited (code ${code}) before responding`)));
        }
      });
      child.send({ id, ...req } as SolveRequest);
    };

    if (activeChildren < MAX_CONCURRENT_CHILDREN) {
      slotHeld = true;
      activeChildren += 1;
      spawnSolve();
    } else {
      childQueue.push(() => {
        slotHeld = true;
        activeChildren += 1;
        spawnSolve();
      });
    }
  });
}

/** Test-only: clear the entry/happy caches so dispatch order can be re-run. */
export function __resetCaptchaWorkerDispatchForTest(): void {
  entryPathCache = undefined;
  happyMod = null;
  lastNotedMode = "";
}

/**
 * Test-only: substitute the in-process solver. Tests must use this seam
 * instead of mock.module("./captcha-happy.js", …) — a module mock is
 * process-wide in Bun and leaks a PARTIAL export surface into whichever
 * test file loads captcha-happy afterwards (breaking e.g. __captchaMemStats
 * importers, order-dependently across platforms).
 */
export function __setInProcessSolverForTest(fn: InProcessSolveFn | null): void {
  inProcessOverride = fn;
}
