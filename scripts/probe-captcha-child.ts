/**
 * probe-captcha-child.ts — one-shot repro for the 2026-10-07 OOM/crash report.
 *
 * Runs real solves through the real dispatch backend (ZCODE_CAPTCHA_WORKER=off
 * → child-process fork of the bundle, exactly what serve does) and reports:
 *   - elapsed / ok / error per attempt
 *   - PEAK bun.exe process count during each attempt (sampled via tasklist)
 * Child stderr (Bun crash banners, [sync-xhr-err] ...) interleaves into this
 * output on purpose — that is the evidence being collected.
 *
 * Usage:
 *   ZCODE_CAPTCHA_WORKER=off bun run scripts/probe-captcha-child.ts direct 3
 *   ZCODE_CAPTCHA_WORKER=off bun run scripts/probe-captcha-child.ts proxy http://127.0.0.1:7897 2
 */
import { execSync } from "node:child_process";

function bunCount(): number {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq bun.exe" /FO CSV', { encoding: "utf8" });
    return (out.match(/bun\.exe/g) || []).length;
  } catch {
    return -1;
  }
}

const mode = process.argv[2] ?? "direct";
const proxyUrl = process.argv[3] ?? "http://127.0.0.1:7897";
const rounds = Number(process.argv[4] ?? 3);

const appVersion = "3.14.0";
const cfgResp = await fetch(`https://zcode.z.ai/api/v1/client/configs?app_version=${appVersion}&platform=win32-x64`);
const cfgJson = (await cfgResp.json()) as { data?: { configs?: { captcha?: { enabled: boolean; prefix: string; sceneId: string; region: string } } } };
const cfg = cfgJson?.data?.configs?.captcha;
if (!cfg?.enabled) {
  console.error(`[probe] captcha config unavailable: ${JSON.stringify(cfgJson).slice(0, 200)}`);
  process.exit(1);
}
console.log(`[probe] mode=${mode} proxy=${mode === "proxy" ? proxyUrl : "-"} rounds=${rounds} cfg(scene=${cfg.sceneId} region=${cfg.region})`);

const { solveViaWorkerOrInProcess } = await import("../src/proxy/captcha-worker-dispatch.js");

for (let i = 1; i <= rounds; i++) {
  const t0 = Date.now();
  let peak = bunCount();
  const sampler = setInterval(() => {
    const c = bunCount();
    if (c > peak) peak = c;
  }, 400);
  try {
    const param = await solveViaWorkerOrInProcess({
      scene: cfg.sceneId,
      region: cfg.region,
      prefix: cfg.prefix,
      ...(mode === "proxy" ? { proxyUrl } : {}),
    });
    console.log(`[probe] #${i} OK ${Date.now() - t0}ms paramLen=${param.length} peakBun=${peak}`);
  } catch (err) {
    console.log(`[probe] #${i} FAIL ${Date.now() - t0}ms peakBun=${peak} err=${(err as Error).message.slice(0, 300)}`);
  } finally {
    clearInterval(sampler);
  }
  if (i < rounds) await new Promise((r) => setTimeout(r, 3_000));
}
console.log(`[probe] bun.exe after=${bunCount()} (includes this probe)`);
