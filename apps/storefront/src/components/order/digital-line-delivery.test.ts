// @vitest-environment node

import { describe, expect, it } from "vitest";
import { digitalLineDeliveryMarkup } from "./digital-line-delivery";
import { lineExtrasMarkup, type OrderLine } from "@/lib/order-line-extras";

const NOW = Date.parse("2026-09-25T00:00:00Z");

function line(extras: OrderLine["extras"]): OrderLine {
  return { id: "oi_1", productId: "prod_1", variantId: "var_1", quantity: 1, productName: "Ebook", extras };
}

const withDownloads = line({
  downloads: [
    { entitlementId: "dge_1", displayName: "Ebook.pdf", downloadCount: 2, downloadLimit: 5, expiresAt: null, revoked: false },
    { entitlementId: "dge_2", displayName: "Bonus.zip", downloadCount: 0, downloadLimit: null, expiresAt: null, revoked: true },
  ],
  licenceKeys: [{ keyId: "dlk_1", last4: "9F3A" }],
});

describe("digitalLineDeliveryMarkup", () => {
  it("renders nothing for a line without downloads or keys", () => {
    expect(digitalLineDeliveryMarkup(line(undefined), { orderId: "ord_1", access: "account" }, { notice: null })).toBe("");
    expect(digitalLineDeliveryMarkup(line({ downloads: [], licenceKeys: [] }), { orderId: "ord_1", access: "receipt" }, { notice: null })).toBe("");
    // Malformed extras from an older API are ignored, not rendered.
    expect(digitalLineDeliveryMarkup(line({ downloads: "nope" as never, licenceKeys: [{ keyId: "" }] as never }), { orderId: "ord_1", access: "account" }, { notice: null })).toBe("");
  });

  it("uses the account session on the account order page (no orderId field)", () => {
    const html = digitalLineDeliveryMarkup(withDownloads, { orderId: "ord_1", access: "account" }, { notice: null, nowMs: NOW });
    expect(html).toContain('action="/api/downloads/ticket"');
    expect(html).toContain('name="returnTo" value="/account/orders/ord_1"');
    expect(html).not.toContain('name="orderId"');
    expect(html).toContain("2 of 5 downloads used");
    expect(html).toContain("The store removed access to this file.");
    expect(html.match(/<form/g)?.length).toBe(2); // one Download (the revoked file has none) + one Show key
    expect(html).toContain("•••• 9F3A");
  });

  it("sends the order id with receipt forms and returns to the receipt", () => {
    const html = digitalLineDeliveryMarkup(withDownloads, { orderId: "ord_1", access: "receipt" }, {
      notice: null,
      returnTo: "/order-success?orderId=ord_1",
      nowMs: NOW,
    });
    expect(html.match(/name="orderId" value="ord_1"/g)?.length).toBe(2);
    expect(html).toContain('name="returnTo" value="/order-success?orderId=ord_1"');
    const usedUp = digitalLineDeliveryMarkup(line({
      downloads: [{ entitlementId: "dge_1", displayName: "Ebook.pdf", downloadCount: 5, downloadLimit: 5, expiresAt: null, revoked: false }],
    }), { orderId: "ord_1", access: "receipt" }, { notice: null, nowMs: NOW });
    expect(usedUp).toContain('href="#conversation"');
    expect(usedUp).not.toContain("<form");
  });

  it("is composed into the account order line extras", () => {
    const html = lineExtrasMarkup(withDownloads, { orderId: "ord_1", access: "account" });
    expect(html).toContain("dge_1");
  });

  it("shows the outcome of a refused download on that file", () => {
    const html = digitalLineDeliveryMarkup(withDownloads, { orderId: "ord_1", access: "account" }, {
      notice: { flag: "limit", entitlementId: "dge_1" },
      nowMs: NOW,
    });
    expect(html).toContain("used every download of this file");
  });
});
