import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetCaptchaWorkerDispatchForTest,
  __setInProcessSolverForTest,
  solveViaWorkerOrInProcess,
} from "./captcha-worker-dispatch.js";

// Default (worker) mode must degrade, not fail, when the worker path is
// unusable; env=off (child) mode must instead FAIL a lost child — never
// degrade to the main thread. Worker mode is exercised with a REAL
// worker_threads round trip against a canned fixture entry (no happy-dom, no
// network); the fallback cases substitute the in-process solver through the
// test seam. Neither captcha-solver.js nor captcha-happy.js is module-mocked
// here: those mocks are process-wide in Bun and leak partial export surfaces
// into later test files (order-dependent across platforms).
describe("captcha worker dispatch (worker / in-process)", () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-worker-"));
  const fixturePath = path.join(fixtureDir, "fixture-worker.mjs");
  fs.writeFileSync(
    fixturePath,
    [
      'import { parentPort } from "node:worker_threads";',
      "if (!parentPort) throw new Error('fixture requires parent port');",
      "parentPort.on('message', (m) => {",
      "  parentPort.postMessage({ id: m.id, ok: true, param: `fixture-param:${m.scene}:${m.region}` });",
      "});",
    ].join("\n"),
    "utf8",
  );
  afterAll(() => {
    __setInProcessSolverForTest(null);
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  });

  test("solves via a real worker when the entry asset resolves", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: fixturePath }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc1", region: "rg1", prefix: "pf1" });
    expect(param).toBe("fixture-param:sc1:rg1");
  });

  test("falls back to in-process solving when the entry is unavailable", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __setInProcessSolverForTest(
      async (opts) => `inproc-param:${opts.scene}`,
    );
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc2", region: "rg2", prefix: "pf2" });
    expect(param).toBe("inproc-param:sc2");
  });

  test("an unloadable worker entry degrades to in-process solving", async () => {
    // A path that cannot be loaded as a worker module (a directory) surfaces
    // as an async module-not-found 'error' — it must fall back, not reject.
    mock.module("./captcha-worker-asset.js", () => ({ default: fixtureDir }));
    __setInProcessSolverForTest(
      async (opts) => `inproc-param:${opts.scene}`,
    );
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc3", region: "rg3", prefix: "pf3" });
    expect(param).toBe("inproc-param:sc3");
  });

  test("ZCODE_CAPTCHA_WORKER=off does NOT fall back to in-process when the child dies", async () => {
    // The no-AVX2 failure shape: worker-thread solving crashes the process
    // uncatchably, so env=off must not spawn one. The last rung matters too:
    // a dead child must FAIL the solve, never degrade to in-process solving —
    // that would run captcha-happy on the MAIN thread, whose sync-XHR helper
    // spawns its own worker_threads Worker (the exact crash we switched off)
    // and blocks the event loop for up to 12s per sync XHR (#54 shape).
    mock.module("./captcha-worker-asset.js", () => ({ default: fixturePath }));
    let inProcessCalled = false;
    __setInProcessSolverForTest(async () => {
      inProcessCalled = true;
      return "must-not-happen";
    });
    __resetCaptchaWorkerDispatchForTest();
    process.env.ZCODE_CAPTCHA_WORKER = "off";
    try {
      // fixturePath only speaks the parentPort protocol — forked, it throws at
      // load and exits nonzero (child died before answering).
      await expect(
        solveViaWorkerOrInProcess({ scene: "sc4", region: "rg4", prefix: "pf4" }),
      ).rejects.toThrow(/no in-process fallback/);
      expect(inProcessCalled).toBe(false);
    } finally {
      delete process.env.ZCODE_CAPTCHA_WORKER;
    }
  });

  test("ZCODE_CAPTCHA_WORKER=off with a missing entry fails instead of solving in-process", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    __resetCaptchaWorkerDispatchForTest();
    process.env.ZCODE_CAPTCHA_WORKER = "off";
    try {
      await expect(
        solveViaWorkerOrInProcess({ scene: "sc6", region: "rg6", prefix: "pf6" }),
      ).rejects.toThrow(/entry unavailable/);
    } finally {
      delete process.env.ZCODE_CAPTCHA_WORKER;
    }
  });

  test("ZCODE_CAPTCHA_WORKER=off solves via a real forked child (child-mode entry)", async () => {
    // The no-AVX2 fix shape: env=off forks the SAME bundle, whose dual-mode
    // entry answers over the child_process IPC channel instead of parentPort.
    const childFixturePath = path.join(fixtureDir, "fixture-child.cjs");
    fs.writeFileSync(
      childFixturePath,
      [
        'if (typeof process.send === "function") {',
        '  process.on("message", (m) => process.send({ id: m.id, ok: true, param: "child-param:" + m.scene }));',
        "} else {",
        "  process.exit(3);",
        "}",
      ].join("\n"),
      "utf8",
    );
    mock.module("./captcha-worker-asset.js", () => ({ default: childFixturePath }));
    __resetCaptchaWorkerDispatchForTest();
    process.env.ZCODE_CAPTCHA_WORKER = "off";
    try {
      const param = await solveViaWorkerOrInProcess({ scene: "sc5", region: "rg5", prefix: "pf5" });
      expect(param).toBe("child-param:sc5");
    } finally {
      delete process.env.ZCODE_CAPTCHA_WORKER;
    }
  });

  test("proxyUrl threads through to the worker entry (claim mint via account exit)", async () => {
    // The egress-consistency seam: the claim plane solves its captcha through
    // the account's mihomo exit, so the fixture must receive proxyUrl in the
    // solve message on BOTH backends (worker thread and fork child).
    const echoFixture = path.join(fixtureDir, "fixture-echo-proxy.cjs");
    fs.writeFileSync(
      echoFixture,
      [
        'const reply = (post, m) => post({ id: m.id, ok: true, param: m.proxyUrl ? "via:" + m.proxyUrl : "direct" });',
        'const { parentPort } = require("node:worker_threads");',
        "if (parentPort) {",
        "  parentPort.on('message', (m) => reply((r) => parentPort.postMessage(r), m));",
        "} else if (typeof process.send === 'function') {",
        "  process.on('message', (m) => reply((r) => process.send(r), m));",
        "} else { process.exit(3); }",
      ].join("\n"),
      "utf8",
    );
    mock.module("./captcha-worker-asset.js", () => ({ default: echoFixture }));
    __resetCaptchaWorkerDispatchForTest();
    // Worker-thread backend (default env).
    expect(await solveViaWorkerOrInProcess({ scene: "s", region: "r", prefix: "p", proxyUrl: "http://127.0.0.1:47001" }))
      .toBe("via:http://127.0.0.1:47001");
    expect(await solveViaWorkerOrInProcess({ scene: "s", region: "r", prefix: "p" })).toBe("direct");
    // Fork backend (env=off) — same protocol, same field.
    process.env.ZCODE_CAPTCHA_WORKER = "off";
    try {
      __resetCaptchaWorkerDispatchForTest();
      expect(await solveViaWorkerOrInProcess({ scene: "s", region: "r", prefix: "p", proxyUrl: "http://127.0.0.1:47002" }))
        .toBe("via:http://127.0.0.1:47002");
    } finally {
      delete process.env.ZCODE_CAPTCHA_WORKER;
    }
  });
});
