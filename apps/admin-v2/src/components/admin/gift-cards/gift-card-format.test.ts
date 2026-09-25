import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "~/i18n";
import { adjustmentFor, EMPTY_ISSUE_DRAFT, issueRequestBody, validateIssueDraft } from "./gift-card-drafts";
import {
  formatGiftCardMoney,
  giftCardDisplayStatus,
  giftCardExpiresAtFromDay,
  giftCardLastDay,
  isValidExpiryDay,
  isValidRecipientPhone,
} from "./gift-card-format";
import { giftCardSearchTerm, validateGiftCardListSearch } from "./gift-card-list-state";

afterEach(() => setLocale("en"));

// 2026-09-25 12:00 in Dhaka (UTC+6).
const NOON_DHAKA = Date.UTC(2026, 8, 25, 6, 0, 0);

describe("gift card status", () => {
  it("reads disabled before expired before used up", () => {
    expect(giftCardDisplayStatus({ status: "disabled", expired: true, balanceMinor: 0 })).toBe("disabled");
    expect(giftCardDisplayStatus({ status: "active", expired: true, balanceMinor: 500 })).toBe("expired");
    expect(giftCardDisplayStatus({ status: "active", expired: false, balanceMinor: 0 })).toBe("usedUp");
    expect(giftCardDisplayStatus({ status: "active", expired: false, balanceMinor: 1 })).toBe("active");
  });
});

describe("gift card expiry days", () => {
  it("ends a chosen day at the next Dhaka midnight and reads it back as that day", () => {
    const expiresAt = giftCardExpiresAtFromDay("2026-12-31");
    expect(expiresAt).toBe("2026-12-31T18:00:00.000Z");
    expect(giftCardLastDay(expiresAt)).toBe("2026-12-31");
    expect(giftCardLastDay(null)).toBeNull();
    expect(giftCardExpiresAtFromDay("not a day")).toBeNull();
  });

  it("accepts today or later only", () => {
    expect(isValidExpiryDay("2026-09-25", NOON_DHAKA)).toBe(true);
    expect(isValidExpiryDay("2026-09-24", NOON_DHAKA)).toBe(false);
    expect(isValidExpiryDay("", NOON_DHAKA)).toBe(false);
  });
});

describe("gift card money and contacts", () => {
  it("formats minor units in the card's currency", () => {
    expect(formatGiftCardMoney(123_456_700, "BDT")).toBe("৳12,34,567.00");
  });

  it("takes a Bangladesh mobile or a full international number", () => {
    expect(isValidRecipientPhone("01712-345678")).toBe(true);
    expect(isValidRecipientPhone("০১৭১২৩৪৫৬৭৮")).toBe(true);
    expect(isValidRecipientPhone("+44 20 7946 0958")).toBe(true);
    expect(isValidRecipientPhone("12345")).toBe(false);
  });
});

describe("gift card list search", () => {
  it("cuts a pasted whole code to its last 4 so it never travels in a query string", () => {
    expect(giftCardSearchTerm("ABCD-EFGH-JKMN-7K2Q")).toBe("7K2Q");
    expect(giftCardSearchTerm("abcd efgh jkmn 7k2q")).toBe("7K2Q");
    expect(giftCardSearchTerm("7K2Q")).toBe("7K2Q");
    expect(giftCardSearchTerm("Rahim")).toBe("Rahim");
  });

  it("keeps only a known status tab in the URL", () => {
    expect(validateGiftCardListSearch({ status: "expired" })).toEqual({ status: "expired" });
    expect(validateGiftCardListSearch({ status: "all" })).toEqual({});
    expect(validateGiftCardListSearch({ status: "bogus", q: "7K2Q" })).toEqual({});
  });
});

describe("issue request", () => {
  const draft = { ...EMPTY_ISSUE_DRAFT, amount: 500 };

  it("needs an amount, a valid contact and somewhere to send it", () => {
    expect(validateIssueDraft({ ...EMPTY_ISSUE_DRAFT }, "BDT", NOON_DHAKA)).toEqual({ amount: "amountRequired", notify: "notifyNeedsTarget" });
    expect(validateIssueDraft({ ...draft, notify: false }, "BDT", NOON_DHAKA)).toEqual({});
    expect(validateIssueDraft({ ...draft, contact: "nope" }, "BDT", NOON_DHAKA)).toEqual({ contact: "emailInvalid" });
    expect(validateIssueDraft({ ...draft, deliverBy: "sms", contact: "01712345678" }, "BDT", NOON_DHAKA)).toEqual({});
    expect(validateIssueDraft({ ...draft, customer: { id: "cus_1", name: "Rahim" }, hasExpiry: true, expiryDay: "2026-01-01" }, "BDT", NOON_DHAKA))
      .toEqual({ expiry: "expiryInvalid" });
  });

  it("sends one contact, an explicit expiry and notify only with a target", () => {
    expect(issueRequestBody({ ...draft, notify: false }, "key-1")).toEqual({ requestKey: "key-1", amount: 500, expiresAt: null, notify: false });
    expect(issueRequestBody({
      ...draft,
      hasExpiry: true,
      expiryDay: "2026-12-31",
      recipientName: " Karim ",
      deliverBy: "sms",
      contact: " 01712345678 ",
      message: " Eid Mubarak ",
      note: "",
    }, "key-2")).toEqual({
      requestKey: "key-2",
      amount: 500,
      expiresAt: "2026-12-31T18:00:00.000Z",
      recipient: { name: "Karim", phone: "01712345678" },
      message: "Eid Mubarak",
      notify: true,
    });
  });
});

describe("balance adjustment", () => {
  const card = { balanceMinor: 50_000, currencyCode: "BDT" };

  it("signs the amount and needs a reason", () => {
    expect(adjustmentFor({ direction: "decrease", amount: 200, reason: " correction " }, card))
      .toEqual({ body: { amount: -200, reason: "correction" }, deltaMinor: -20_000 });
    expect(adjustmentFor({ direction: "increase", amount: 100, reason: "" }, card)).toEqual({ errors: { reason: "reasonRequired" } });
  });

  it("never takes the balance below zero", () => {
    expect(adjustmentFor({ direction: "decrease", amount: 501, reason: "x" }, card)).toEqual({ errors: { amount: "belowZero" } });
    expect(adjustmentFor({ direction: "increase", amount: null, reason: "x" }, card)).toEqual({ errors: { amount: "amountRequired" } });
  });
});
