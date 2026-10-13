import { describe, expect, it } from "vitest";
import {
  SCANNER_COOKIE_NAME,
  buildScannerSessionCookie,
  isAllowedScannerApiRequest,
  parseCookie,
} from "./scanner-auth";

describe("scanner auth helpers", () => {
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
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/locations", "GET")).toBe(true);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/locations", "POST")).toBe(false);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/locations/loc_1/archive", "POST")).toBe(false);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/variant_1/adjust", "POST")).toBe(false);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory", "GET")).toBe(false);
  });

  it("allows receiving a purchase order or transfer by scan, and nothing else on them", () => {
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/purchase-orders", "GET")).toBe(true);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/purchase-orders/po_abc123", "GET")).toBe(true);
    expect(isAllowedScannerApiRequest("/admin/inventory/purchase-orders/po_abc123/receive", "POST")).toBe(true);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/transfers", "GET")).toBe(true);
    expect(isAllowedScannerApiRequest("/api/v1/admin/inventory/transfers/trf_1/receive", "POST")).toBe(true);
    for (const [path, method] of [
      ["/api/v1/admin/inventory/purchase-orders", "POST"],
      ["/api/v1/admin/inventory/purchase-orders/po_1", "PUT"],
      ["/api/v1/admin/inventory/purchase-orders/po_1/cancel", "POST"],
      ["/api/v1/admin/inventory/purchase-orders/po_1/order", "POST"],
      ["/api/v1/admin/inventory/purchase-orders/po_1/export", "GET"],
      ["/api/v1/admin/inventory/transfers/trf_1/ship", "POST"],
      ["/api/v1/admin/inventory/transfers/trf_1/cancel", "POST"],
      ["/api/v1/admin/inventory/purchase-orders/po_1/receive/extra", "POST"],
      ["/api/v1/admin/inventory/purchase-orders/../costs", "PUT"],
      ["/api/v1/admin/inventory/costs", "PUT"],
      ["/api/v1/admin/inventory/suppliers", "GET"],
    ] as const) {
      expect(isAllowedScannerApiRequest(path, method), `${method} ${path}`).toBe(false);
    }
  });
});
