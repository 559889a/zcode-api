/**
 * Managed mihomo — spawns a mihomo child process that exposes one local
 * mixed (HTTP+SOCKS) listener per Clash node, each pinned to its node, so
 * every account can have its own stable outbound IP.
 *
 * Generated config shape (per node i):
 *   listeners: [{ name: pool-i, type: mixed, listen: 127.0.0.1,
 *                 port: basePort+i, proxy: <node.name> }]
 *   proxies:   [ ...user Clash entries verbatim... ]
 *
 * The listener-level `proxy` pin bypasses rule matching entirely, so no rules/
 * groups are generated. Binary resolution: explicit `binary` config → `mihomo`
 * on PATH. When nothing is found the pool runs direct with a loud warning
 * (the proxy pool is an IP-hygiene feature, not availability-critical).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect as connectTcp, createServer } from "node:net";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { stringify } from "yaml";
import type { ProxyConfig } from "../config/types.js";

export interface MihomoEndpoint {
  /** Local mixed-listener URL, e.g. `http://127.0.0.1:47000`. */
  url: string;
  /** Clash node `name` this listener is pinned to. */
  label: string;
}

export interface MihomoRuntime {
  endpoints: MihomoEndpoint[];
  configPath: string;
  stop: () => void;
}

const LISTEN_HOST = "127.0.0.1";

/** Pure config generator (exported for tests). `ports[i]` is listener i's local port. */
export function buildMihomoConfig(
  nodes: Record<string, unknown>[],
  ports: number[],
): { config: Record<string, unknown>; endpoints: MihomoEndpoint[] } {
  if (ports.length < nodes.length) {
    throw new Error(`need ${nodes.length} listener ports, got ${ports.length}`);
  }
  const listeners = nodes.map((node, i) => ({
    name: `zcode-pool-${i}`,
    type: "mixed",
    listen: LISTEN_HOST,
    port: ports[i],
    proxy: String(node.name),
  }));
  const endpoints = nodes.map((node, i) => ({
    url: `http://${LISTEN_HOST}:${ports[i]}`,
    label: String(node.name),
  }));
  return {
    config: {
      // Listeners pin their outbound; keep everything else inert — no rule
      // engine work, no DNS hijacking, no geo databases, no external controller.
      mode: "direct",
      "log-level": "warning",
      ipv6: false,
      listeners,
      proxies: nodes,
    },
    endpoints,
  };
}

/** Store dir override seam (same env var the credential store uses). */
function runtimeDir(): string {
  return process.env.ZCODE_PROXY_STORE_DIR?.trim() || join(homedir(), ".zcode-proxy");
}

function configPath(): string {
  return join(runtimeDir(), "mihomo-pool.yaml");
}

function resolveBinary(explicit?: string): string | null {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    console.error(`[proxy-pool] mihomo binary not found at "${explicit}" — install it or fix proxyPool.mihomo.binary`);
    return null;
  }
  for (const candidate of process.platform === "win32" ? ["mihomo.exe", "mihomo"] : ["mihomo"]) {
    try {
      const res = spawnSync(candidate, ["-v"], { stdio: "ignore", windowsHide: true });
      if (res.status === 0) return candidate;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

/** TCP-connect probe with retries — resolves when the first listener accepts. */
function probeReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = connectTcp({ host: LISTEN_HOST, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

/**
 * True when nothing is bound to 127.0.0.1:port right now. Detection by
 * trial-bind: an occupied port (any other proxy tool's pool listeners, clash
 * panels, etc.) refuses the exclusive bind.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host: LISTEN_HOST, port, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * First `count` free ports starting at `base`, skipping anything already
 * listening — the auto-yield for hosts running several proxy tools whose
 * pools grab port ranges. Ports are chosen ONCE per process lifetime; if
 * something steals one between this probe and the mihomo bind, the watchdog
 * keeps retrying mihomo with the same ports (ceiling: a persistent squatter
 * on our chosen ports needs a proxyPool.mihomo.listenBasePort change).
 */
export async function findFreePorts(base: number, count: number): Promise<number[]> {
  const out: number[] = [];
  let candidate = base;
  for (let i = 0; i < count; i++) {
    while (!(await isPortFree(candidate))) candidate += 1;
    out.push(candidate);
    candidate += 1;
  }
  return out;
}

/**
 * Start the managed mihomo process for `config.proxyPool`. Returns null (with
 * a loud warning) when disabled, nodeless, or the binary is unavailable.
 */
export async function startMihomoPool(config: ProxyConfig): Promise<MihomoRuntime | null> {
  const pool = config.proxyPool;
  if (!pool?.enabled) return null;
  const nodes = pool.mihomo.nodes;
  if (nodes.length === 0) {
    console.warn("[proxy-pool] enabled but proxyPool.mihomo.nodes is empty — accounts will run direct");
    return null;
  }

  const binary = resolveBinary(pool.mihomo.binary);
  if (!binary) {
    console.error(
      "[proxy-pool] mihomo binary not found on PATH — accounts will run DIRECT. " +
        "Install mihomo (https://github.com/MetaCubeX/mihomo/releases) or set proxyPool.mihomo.binary.",
    );
    return null;
  }

  // Auto-yield: pick the first free port for every listener, so other proxy
  // software sitting on 47000+ doesn't break the pool.
  const ports = await findFreePorts(pool.mihomo.listenBasePort, nodes.length);
  let expected = pool.mihomo.listenBasePort;
  for (const port of ports) {
    if (port !== expected) console.log(`[proxy-pool] port ${expected} busy — listener shifted to ${port}`);
    expected = port + 1;
  }
  const { config: gen, endpoints } = buildMihomoConfig(nodes, ports);
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(gen), "utf-8");

  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  // Hang watchdog: a HUNG mihomo (listeners still bound, core dead — observed
  // after an overnight host sleep/resume, 2026-10-07) never exits, so the
  // restart-on-exit path below can't fire. Probe the first listener
  // periodically; after consecutive misses kill the child — the exit handler
  // then respawns it through the normal backoff path. `ponytail:` ceiling —
  // one probe port only; a hang limited to other listeners goes unnoticed.
  let hangMisses = 0;
  const watchdog: ReturnType<typeof setInterval> = setInterval(() => {
    if (stopping || !child) return;
    void probeReady(endpointPort(endpoints[0].url), 3_000).then((alive) => {
      if (stopping) return;
      hangMisses = alive ? 0 : hangMisses + 1;
      if (hangMisses >= 3) {
        console.error("[proxy-pool] mihomo listeners unresponsive — killing the hung process for restart");
        hangMisses = 0;
        try { child?.kill(); } catch {}
      }
    });
  }, 60_000);
  watchdog.unref?.();

  const launch = (): void => {
    child = spawn(binary, ["-d", dirname(path), "-f", path], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) console.log(`[mihomo] ${text}`);
    });
    child.on("exit", (code) => {
      if (stopping) return;
      restarts += 1;
      const backoff = Math.min(1000 * 2 ** Math.min(restarts, 5), 30_000);
      console.error(`[proxy-pool] mihomo exited (code ${code}) — restarting in ${backoff / 1000}s`);
      setTimeout(() => {
        if (!stopping) launch();
      }, backoff);
    });
  };

  launch();
  const ready = await probeReady(endpointPort(endpoints[0].url), 5000);
  if (!ready && !stopping) {
    console.error(`[proxy-pool] mihomo did not open ${endpoints[0].url} within 5s — continuing; it may come up late`);
  }

  for (const e of endpoints) console.log(`[proxy-pool] listener ${e.url} -> node "${e.label}"`);

  const stop = (): void => {
    stopping = true;
    clearInterval(watchdog);
    child?.kill();
  };
  // Last-resort cleanup if the owner forgets (tests, short-lived CLIs).
  process.on("exit", stop);
  return { endpoints, configPath: path, stop };
}

function endpointPort(url: string): number {
  return Number(new URL(url).port);
}
