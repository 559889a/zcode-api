/** buildMihomoConfig — pure config generation; isPortFree/findFreePorts — auto-yield probes. */
import { describe, it, expect } from "bun:test";
import { createServer, type Server } from "node:net";
import { buildMihomoConfig, isPortFree, findFreePorts } from "./mihomo.js";

const NODE_JP = { name: "node-jp", type: "ss", server: "jp.example.com", port: 8388, cipher: "aes-256-gcm", password: "x" };
const NODE_SG = { name: "node-sg", type: "vmess", server: "sg.example.com", port: 443, uuid: "u", alterId: 0, cipher: "auto" };

describe("buildMihomoConfig", () => {
  it("creates one pinned mixed listener per node at the given ports", () => {
    const { config, endpoints } = buildMihomoConfig([NODE_JP, NODE_SG], [47000, 47007]);
    const listeners = config.listeners as Array<Record<string, unknown>>;
    expect(listeners).toHaveLength(2);
    expect(listeners[0]).toEqual({ name: "zcode-pool-0", type: "mixed", listen: "127.0.0.1", port: 47000, proxy: "node-jp" });
    expect(listeners[1]).toEqual({ name: "zcode-pool-1", type: "mixed", listen: "127.0.0.1", port: 47007, proxy: "node-sg" });
    expect(endpoints).toEqual([
      { url: "http://127.0.0.1:47000", label: "node-jp" },
      { url: "http://127.0.0.1:47007", label: "node-sg" },
    ]);
  });

  it("passes user proxies through verbatim and keeps everything else inert", () => {
    const { config } = buildMihomoConfig([NODE_JP], [47000]);
    expect(config.proxies).toEqual([NODE_JP]);
    expect(config.mode).toBe("direct");
    expect(config["log-level"]).toBe("warning");
    expect(config["external-controller"]).toBeUndefined();
    expect(config.rules).toBeUndefined();
  });

  it("supports an empty node list (no listeners, no endpoints)", () => {
    const { config, endpoints } = buildMihomoConfig([], []);
    expect(config.listeners).toEqual([]);
    expect(endpoints).toEqual([]);
  });

  it("throws when fewer ports than nodes are supplied", () => {
    expect(() => buildMihomoConfig([NODE_JP, NODE_SG], [47000])).toThrow(/listener ports/);
  });
});

/** Bind a throwaway server on an OS-assigned loopback port. */
async function withBusyPort(fn: (port: number, server: Server) => Promise<void>): Promise<void> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve));
  try {
    const port = (srv.address() as { port: number }).port;
    await fn(port, srv);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

describe("port auto-yield probes", () => {
  it("isPortFree: false while a listener holds the port, true after it releases", async () => {
    await withBusyPort(async (port, srv) => {
      expect(await isPortFree(port)).toBe(false);
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      srv.unref();
      expect(await isPortFree(port)).toBe(true);
    });
  });

  it("findFreePorts skips busy ports and returns contiguous free ones", async () => {
    await withBusyPort(async (busyPort) => {
      // Ask for 3 ports starting AT the busy one: expect it skipped and the
      // next three (busy+1..busy+3) returned.
      const ports = await findFreePorts(busyPort, 3);
      expect(ports).toEqual([busyPort + 1, busyPort + 2, busyPort + 3]);
    });
  });
});
