/**
 * Captcha solver execution entry — dual mode:
 *  - worker_threads Worker (parentPort): the default backend.
 *  - child_process fork child (process.send): the `ZCODE_CAPTCHA_WORKER=off`
 *    backend for machines where worker threads crash natively mid-solve
 *    (observed on a no-AVX2 CPU, 2026-10-06) — a fresh full process, equally
 *    off the main event loop, but its death is catchable instead of fatal to
 *    the proxy.
 *
 * Runs the happy-dom solver (captcha-happy.ts) OFF the proxy's main event
 * loop so Atomics.wait sync XHRs never block it. One solve per worker/child
 * at a time: the module's global browser-frame/cookie state is
 * per-execution, which also removes the cross-solve global races of
 * in-process parallel solving.
 *
 * Protocol: {id, scene, region, prefix} in -> {id, ok, param|error} out.
 * Spawned by captcha-worker-dispatch.ts via the captcha-worker-asset.ts
 * file asset (`with { type: "file" }`) -- the only worker mechanism that
 * survives `bun build --compile` single-file binaries (verified on Bun 1.4).
 */
import { parentPort } from "node:worker_threads";
import { solveTraceless } from "./captcha-happy.js";

type SolveMsg = { id: number; scene: string; region: string; prefix: string };
type SolveReply = { id: number; ok: true; param: string } | { id: number; ok: false; error: string };

async function handle(m: SolveMsg, post: (reply: SolveReply) => void): Promise<void> {
  try {
    const param = await solveTraceless({ scene: m.scene, region: m.region, prefix: m.prefix });
    post({ id: m.id, ok: true, param });
  } catch (err) {
    post({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (m: SolveMsg) => {
    void handle(m, (reply) => port.postMessage(reply));
  });
} else if (typeof process.send === "function") {
  process.on("message", (m: SolveMsg) => {
    void handle(m, (reply) => process.send!(reply));
  });
} else {
  throw new Error("captcha entry requires a worker_threads parent or child_process IPC");
}
