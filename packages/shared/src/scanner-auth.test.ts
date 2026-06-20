import { describe, expect, it } from "vitest";
import {
  SCANNER_COOKIE_NAME,
  buildScannerSessionCookie,
  getScannerSessionKey,
  isAllowedScannerApiRequest,
  parseCookie,
} from "./scanner-auth";

describe("scanner auth helpers", () => {
  it("hashes session identifiers before deriving KV keys", async () => {
    const sessionKey = await getScannerSessionKey("session-secret");

    expect(sessionKey).toMatch(/^scanner:session:[a-f0-9]{64}$/);
    expect(sessionKey).not.toContain("session-secret");
  });

  it("builds a secure HttpOnly scanner session cookie", () => {
    const cookie = buildScannerSessionCookie("session 1", 300, { secure: true });

    expect(cookie).toContain(`${SCANNER_COOKIE_NAME}=session%201`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(parseCookie(cookie, SCANNER_COOKIE_NAME)).toBe("session 1");
  });

  it("allows only the scanner inventory workflow endpoints", () => {
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/scanner/lookup", "GET")).toBe(true);
    expect(isAllowedScannerApiRequest("/admin/inventory/stock-adjust", "POST")).toBe(true);
    expect(isAllowedScannerApiRequest("/admin/inventory/stock-set", "POST")).toBe(true);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/variant_1/adjust", "POST")).toBe(false);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory", "GET")).toBe(false);
  });
});
