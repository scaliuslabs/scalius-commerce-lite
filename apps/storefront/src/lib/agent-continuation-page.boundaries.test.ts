import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const storefrontRoot = existsSync(resolve(process.cwd(), "apps", "storefront", "src"))
  ? resolve(process.cwd(), "apps", "storefront")
  : process.cwd();
const source = readFileSync(resolve(
  storefrontRoot,
  "src/pages/agent/continue/[continuationId].astro",
), "utf8");

describe("agent hosted continuation page", () => {
  it("requires the claimed browser cookie as well as the opaque locator and disables caching/referrers", () => {
    expect(source).toContain("/^acn_[A-Za-z0-9_-]{20}$/");
    expect(source).toContain("readAgentContinuationCookie");
    expect(source).toContain('Astro.request.headers.get("cookie")');
    expect(source).toContain('Cache-Control", "private, no-store"');
    expect(source).toContain('Referrer-Policy", "no-referrer"');
    expect(source).toContain("noindex, nofollow, noarchive");
    expect(source).not.toContain("searchParams");
  });

  it("does not import the analytics-enabled shared layout or place sensitive values in URLs", () => {
    expect(source).not.toContain("layouts/Layout.astro");
    expect(source).not.toMatch(/receiptToken|statusToken|checkoutToken|cs_tok|chk_|cst_/);
    expect(source).not.toMatch(/searchParams|location\.search|console\.log/);
    expect(source).toContain('autocomplete="one-time-code"');
    expect(source).toContain('credentials: "same-origin"');
    expect(source).toContain('referrerPolicy: "no-referrer"');
  });

  it("supports each hosted workflow without operation-id instrumentation", () => {
    expect(source).toContain('kind === "customer_auth"');
    expect(source).toContain('kind === "payment"');
    expect(source).toContain('kind === "payment_recovery"');
    expect(source).not.toContain("data-operation-id");
  });
});
