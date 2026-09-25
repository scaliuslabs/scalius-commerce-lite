import { describe, expect, it } from "vitest";

import {
  accountGiftCardStatus,
  giftCardBalanceFailureText,
  giftCardBalanceView,
  giftCardExpiryText,
  giftCardPageStatus,
  giftCardTransactionAmount,
  giftCardTransactionText,
  readGiftCardFormFields,
  GIFT_CARD_PAGE_COPY,
} from "./account-gift-cards";
import { readAccountGiftCard, readGiftCardBalance } from "./api/gift-cards";

describe("gift-card balance page", () => {
  it("answers every miss with the same sentence", () => {
    expect(giftCardBalanceFailureText("not_found")).toBe(GIFT_CARD_PAGE_COPY.notFound);
    expect(giftCardBalanceFailureText("unusable")).toBe(GIFT_CARD_PAGE_COPY.notFound);
    expect(giftCardBalanceFailureText("rate_limited")).toBe(GIFT_CARD_PAGE_COPY.rateLimited);
    expect(giftCardPageStatus({ ok: false, reason: "rate_limited", status: 429 })).toBe(429);
    expect(giftCardPageStatus({ ok: false, reason: "not_found", status: 404 })).toBe(200);
  });

  it("renders the result from the POST answer", () => {
    const card = readGiftCardBalance({
      last4: "7K2Q", balance: 250, balanceMinor: 25_000, currencyCode: "BDT", expiresAt: null, status: "active",
    });
    expect(card).not.toBeNull();
    expect(giftCardBalanceView({ ok: true, data: card! })).toEqual({ kind: "result", card });
    expect(giftCardBalanceView(null)).toEqual({ kind: "form" });
    expect(giftCardExpiryText(null)).toBe("Never expires");
    expect(readGiftCardBalance({ last4: "7K2Q", status: "gone" })).toBeNull();
  });

  it("reads the code from a POST form body", async () => {
    const request = new Request("https://store.test/gift-card-balance", {
      method: "POST",
      body: new URLSearchParams({ code: "ABCD-EFGH-JKMN-7K2Q", other: "x" }),
    });
    expect(await readGiftCardFormFields(request)).toEqual({ code: "ABCD-EFGH-JKMN-7K2Q" });
  });
});

describe("account gift cards", () => {
  const raw = {
    id: "gc_1",
    last4: "7K2Q",
    currencyCode: "BDT",
    initialAmount: 1000,
    initialAmountMinor: 100_000,
    balance: 600,
    balanceMinor: 60_000,
    status: "active",
    expiresAt: "2027-01-01T00:00:00.000Z",
    expired: false,
    source: "purchase",
    createdAt: "2026-09-01T00:00:00.000Z",
    transactions: [
      { id: "gct_1", kind: "issue", amount: 1000, amountMinor: 100_000, balanceAfter: 1000, balanceAfterMinor: 100_000, orderId: null, orderNumber: null, createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "gct_2", kind: "redeem", amount: -400, amountMinor: -40_000, balanceAfter: 600, balanceAfterMinor: 60_000, orderId: "ord_9", orderNumber: "#1042", createdAt: "2026-09-02T00:00:00.000Z" },
      { id: "bad", kind: "steal" },
    ],
  };

  it("reads cards and their history, skipping malformed rows", () => {
    const card = readAccountGiftCard(raw)!;
    expect(card.transactions.map(({ id }) => id)).toEqual(["gct_1", "gct_2"]);
    expect(accountGiftCardStatus(card)).toBe("active");
    expect(accountGiftCardStatus({ status: "active", expired: true })).toBe("expired");
    expect(readAccountGiftCard({ ...raw, status: "weird" })).toBeNull();
  });

  it("names each transaction with its order number", () => {
    expect(giftCardTransactionText({ kind: "redeem", orderNumber: "#1042" })).toBe("Used on order #1042");
    expect(giftCardTransactionText({ kind: "issue", orderNumber: null })).toBe("Issued");
    expect(giftCardTransactionAmount(-400, "BDT")).toBe("−৳400");
    expect(giftCardTransactionAmount(1000, "BDT")).toBe("+৳1,000");
  });
});
