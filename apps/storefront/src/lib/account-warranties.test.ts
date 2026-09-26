import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import {
  accountClaimFormHref,
  canClaimWarranty,
  lineWarrantyMarkup,
  pickWarrantyCopy,
  readBuyerWarranties,
  readLineWarranties,
  readWarrantyClaimNotice,
  warrantyClaimAction,
  warrantyClaimThreadHref,
  warrantyDatesText,
  warrantySummaryText,
  warrantyTimeLeftText,
  withWarrantyClaimStatus,
} from "./account-warranties";
import { safeConversationReturnPath } from "./account-inbox";

const en = pickWarrantyCopy(null, ENGLISH_CHECKOUT_LANGUAGE_DATA);
const bn = pickWarrantyCopy(null, BANGLA_CHECKOUT_LANGUAGE_DATA);
const now = Date.parse("2026-09-25T06:00:00Z");

const line = {
  warrantyId: "wty_abcdefgh1234",
  policyName: "1 year official warranty",
  provider: "brand",
  durationValue: 1,
  durationUnit: "years",
  replacementDays: 7,
  terms: "Covers manufacturing faults.",
  quantity: 1,
  startsAt: "2026-09-20T06:00:00.000Z",
  expiresAt: "2027-09-20T06:00:00.000Z",
  replacementUntil: "2026-09-27T06:00:00.000Z",
  voided: false,
  openClaimId: null,
  claim: null,
};

describe("warranty words", () => {
  it("names the policy like the trust row: duration, provider, replacement", () => {
    expect(warrantySummaryText({ provider: "brand", durationValue: 1, durationUnit: "years", replacementDays: 7 }, en))
      .toBe("1 year brand warranty · 7-day replacement");
    expect(warrantySummaryText({ provider: "store", durationValue: 6, durationUnit: "months", replacementDays: null }, en))
      .toBe("6 months store warranty");
    expect(warrantySummaryText({ provider: "brand", durationValue: 2, durationUnit: "years", replacementDays: 0 }, bn))
      .toBe("2 বছর ব্র্যান্ড ওয়ারেন্টি");
  });

  it("tells the time left and the dates, and says when it ended or was voided", () => {
    expect(warrantyTimeLeftText("2026-10-05T06:00:00Z", now, en)).toBe("10 days left");
    expect(warrantyTimeLeftText("2026-09-25T18:00:00Z", now, en)).toBe("1 day left");
    expect(warrantyTimeLeftText("2027-09-20T06:00:00Z", now, en)).toBe("11 months left");
    expect(warrantyTimeLeftText("2026-09-01T06:00:00Z", now, en)).toBe("");
    expect(warrantyDatesText(line, now, en)).toBe("Warranty until 20 Sep 2027 · Replacement until 27 Sep 2026");
    expect(warrantyDatesText({ ...line, expiresAt: "2026-09-01T06:00:00Z" }, now, en)).toBe("Warranty ended 1 Sep 2026");
    expect(warrantyDatesText({ ...line, voided: true }, now, en)).toBe("Warranty void");
  });
});

describe("warranty records", () => {
  it("reads the line extras and skips malformed entries", () => {
    const [record] = readLineWarranties([line, { ...line, warrantyId: "nope" }, null, { ...line, durationUnit: "weeks" }]);
    expect(readLineWarranties([line, { ...line, warrantyId: "nope" }])).toHaveLength(1);
    expect(record).toMatchObject({ warrantyId: "wty_abcdefgh1234", provider: "brand", replacementDays: 7, claim: null });
    expect(readLineWarranties("x")).toEqual([]);
  });

  it("reads the account's warranties", () => {
    const [warranty] = readBuyerWarranties([{
      ...line,
      orderId: "ord_1",
      orderNumber: "1042",
      orderItemId: "oi_1",
      productId: "p_1",
      productName: "Phone",
      variantLabel: null,
      imageUrl: "javascript:alert(1)",
      state: "active",
      claim: { id: "wcl_abcdefgh1234", conversationId: "cnv_1", status: "in_progress", resolution: null },
    }]);
    expect(warranty).toMatchObject({ orderNumber: "1042", imageUrl: null, claim: { status: "in_progress" } });
  });

  it("allows a claim only on an active warranty without an open claim", () => {
    expect(canClaimWarranty(line, now)).toBe(true);
    expect(canClaimWarranty({ ...line, voided: true }, now)).toBe(false);
    expect(canClaimWarranty({ ...line, expiresAt: "2026-09-01T00:00:00Z" }, now)).toBe(false);
    const claim = { id: "wcl_abcdefgh1234", conversationId: "cnv_1", status: "open" as const };
    expect(canClaimWarranty({ ...line, claim }, now)).toBe(false);
    expect(canClaimWarranty({ ...line, claim: { ...claim, status: "resolved" } }, now)).toBe(true);
  });
});

describe("claim links and outcomes", () => {
  const claim = { id: "wcl_abcdefgh1234", conversationId: "cnv_1", status: "open" as const };

  it("sends the owner to the inbox and a guest to the claim page, with ids only", () => {
    expect(warrantyClaimThreadHref(claim, { kind: "account" })).toBe("/account/inbox/cnv_1");
    expect(warrantyClaimThreadHref(claim, { kind: "receipt", orderId: "ord_1" })).toBe("/warranty-claims/ord_1/wcl_abcdefgh1234");
    expect(warrantyClaimAction("wty_abcdefgh1234", { kind: "account" })).toBe("/api/warranties/wty_abcdefgh1234/claim?access=account");
    expect(warrantyClaimAction("wty_abcdefgh1234", { kind: "receipt", orderId: "ord_1" })).toBe("/api/warranties/wty_abcdefgh1234/claim?orderId=ord_1");
    expect(accountClaimFormHref("wty_abcdefgh1234")).toBe("/account/warranties?claim=wty_abcdefgh1234#warranty-wty_abcdefgh1234");
  });

  it("returns a refused plain post to its form with the flag, and the claim pages are valid return paths", () => {
    const back = withWarrantyClaimStatus("/order-success?orderId=ord_1", "wty_abcdefgh1234", "exists");
    expect(back).toBe("/order-success?orderId=ord_1&claim=wty_abcdefgh1234&claimStatus=exists#warranty-wty_abcdefgh1234");
    expect(readWarrantyClaimNotice(new URL(back, "https://shop.test"))).toEqual({ warrantyId: "wty_abcdefgh1234", flag: "exists" });
    expect(readWarrantyClaimNotice(new URL("/account/warranties?claim=wty_abcdefgh1234&claimStatus=bogus", "https://shop.test")))
      .toEqual({ warrantyId: "wty_abcdefgh1234", flag: null });
    expect(safeConversationReturnPath("/account/warranties")).toBe("/account/warranties");
    expect(safeConversationReturnPath("/warranty-claims/ord_1/wcl_abcdefgh1234")).toBe("/warranty-claims/ord_1/wcl_abcdefgh1234");
    expect(safeConversationReturnPath("/warranty-claims/ord_1/other")).toBeNull();
  });

  it("renders a line's warranty with its claim, escaped", () => {
    const markup = lineWarrantyMarkup(
      { ...readLineWarranties([line])[0]!, claim },
      { copy: en, access: { kind: "receipt", orderId: "ord_1" }, now },
    );
    expect(markup).toContain("1 year brand warranty · 7-day replacement");
    expect(markup).toContain("Claim open");
    expect(markup).toContain('href="/warranty-claims/ord_1/wcl_abcdefgh1234"');
    expect(markup).not.toContain("Make a claim");
    const claimable = lineWarrantyMarkup(readLineWarranties([line])[0]!, {
      copy: en,
      access: { kind: "account" },
      now,
      claimHref: accountClaimFormHref(line.warrantyId),
    });
    expect(claimable).toContain("Make a claim");
  });
});
