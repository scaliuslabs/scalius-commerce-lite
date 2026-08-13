import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(
  process.cwd().endsWith("apps/storefront") ? process.cwd() : resolve(process.cwd(), "apps/storefront"),
  "src/pages/api/agent-continuations/[...path].ts",
), "utf8");

describe("agent continuation same-origin proxy", () => {
  it("uses an exact continuation/action allowlist and service authentication", () => {
    expect(source).toContain("/^acn_[A-Za-z0-9_-]{20}$/");
    expect(source).toContain("POST_ACTIONS");
    expect(source).toContain("shouldRejectCrossOriginCookieRequest");
    expect(source).toContain("readAgentContinuationCookie");
    expect(source).toContain('request.headers.get("cookie")');
    expect(source).toContain("fetchWithRetry");
    expect(source).toMatch(/REQUEST_TIMEOUT_MS[\s\S]*true,[\s\S]*false/);
  });

  it("turns recovery proof into an HttpOnly receipt cookie and strips it from browser JSON", () => {
    expect(source).toContain("createOrderReceiptCookieHeader(orderId, proof)");
    expect(source).toContain('responseHeaders.append("Set-Cookie", receiptCookie)');
    expect(source).toContain("data: { recovered: true, orderId }");
    expect(source).not.toContain("data: { recovered: true, orderId, proof }");
  });

  it("rejects oversized requests and prevents caching/referrer leakage", () => {
    expect(source).toContain("MAX_BODY_BYTES");
    expect(source).toContain('"Cache-Control": "private, no-store"');
    expect(source).toContain('"Referrer-Policy": "no-referrer"');
  });
});
