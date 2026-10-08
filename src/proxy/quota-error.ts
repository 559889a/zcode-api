/**
 * Shared upstream budget-exhaustion detection (biz 1005 "今日免费计划额度
 * 已用完" / "exceed quota limit"; biz 1113 "Insufficient balance or no
 * resource package").
 *
 * Wire shape (captured live 2026-10-08): the gateways answer a budget-dead
 * account with a **tiny JSON envelope behind an unremarkable HTTP status** —
 * 1005 arrives with HTTP 200 (even for stream requests), 1113 behind HTTP
 * 429 — so status-based key-class checks either never fired (1005: one
 * exhausted account failed every request without the pool rotating) or
 * burned the full strike ladder (1113). Detection sniffs the first body
 * bytes of any non-SSE response (clone-peek, ≤2 chunks — the error body is
 * ~80 bytes) for the JSON code marker, inflating first when the body arrives
 * gzipped.
 *
 * Echo safety: a legitimate reply quoting `{"code":1005}` in its CONTENT is
 * string-escaped in the envelope (`\"code\":1005`), which the raw-quote
 * markers cannot match — only a real top-level error envelope matches.
 *
 * ponytail: ceiling — a quota error delivered as a mid-stream SSE event
 * AFTER content has been relayed is undetectable (bytes already on the wire
 * to the client); no such shape has been observed (stream requests get the
 * JSON body too). Upgrade path: tap the observeStream stats feed for
 * error-only streams and strike retroactively.
 */
import { decodeMaybeGzip } from "./captcha-retry.js";

/**
 * Magic strings of the two "this key has no budget" envelopes, for both JSON
 * spacing styles. 1005 = free-plan quota exhausted (HTTP 200, start-plan and
 * coding gateway); 1113 = insufficient balance / no resource package
 * (observed behind HTTP 429 on the raw api.z.ai plane). Both are definitive
 * budget states, not transient rate limits — they cool the account at once.
 */
export const QUOTA_EXHAUSTED_MARKERS = [
  '"code":1005', '"code": 1005', '"code":"1005"',
  '"code":1113', '"code": 1113', '"code":"1113"',
] as const;

/** Error bodies are tiny; two chunks / 8KB is a generous ceiling. */
const PEEK_MAX_CHUNKS = 2;
const PEEK_MAX_BYTES = 8 * 1024;

/**
 * True when the response body carries the biz-1005 quota envelope. The
 * response stays fully consumable for every downstream path (the peek reads
 * a CLONE). Never throws.
 */
export async function detectQuotaExhausted(resp: Response): Promise<boolean> {
  try {
    const ctype = resp.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) return false;
    const bytes = await peekFirstBodyBytes(resp);
    if (bytes.byteLength === 0) return false;
    const text = await decodeMaybeGzip(bytes, resp.headers.get("content-encoding"));
    return QUOTA_EXHAUSTED_MARKERS.some((marker) => text.includes(marker));
  } catch {
    return false;
  }
}

/** Read the first chunks (bounded) from a clone of the response body. */
async function peekFirstBodyBytes(resp: Response): Promise<Uint8Array> {
  const body = resp.clone().body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (let i = 0; i < PEEK_MAX_CHUNKS; i += 1) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      total += value.byteLength;
      if (total >= PEEK_MAX_BYTES) break;
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  return Buffer.concat(parts);
}
