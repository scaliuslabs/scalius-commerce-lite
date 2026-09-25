// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GIFT_CARD_CHECKOUT_COPY,
  GIFT_CARD_STORAGE_KEY,
  addStoredGiftCard,
  clearStoredGiftCards,
  giftCardCheckoutCopy,
  giftCardQuoteRefusal,
  giftCardRequestFields,
  readAppliedGiftCard,
  readStoredGiftCards,
  removeStoredGiftCards,
  requestGiftCardApply,
  writeStoredGiftCards,
  type StoredGiftCard,
} from "./gift-cards";
import { clearCheckoutTransferSession } from "./session-state";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";

const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);
const handle = (seed: string) => `gch_${seed.repeat(48).slice(0, 48)}`;

function card(seed: string, overrides: Partial<StoredGiftCard> = {}): StoredGiftCard {
  return {
    handle: handle(seed),
    last4: "7K2Q",
    balance: 500,
    balanceMinor: 50_000,
    currencyCode: "BDT",
    handleExpiresAt: NOW + 60 * 60 * 1000,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stored gift cards", () => {
  it("keeps handles in sessionStorage only, never localStorage, and never a code", () => {
    const added = addStoredGiftCard([], card("a"));
    expect(added.ok).toBe(true);
    const raw = sessionStorage.getItem(GIFT_CARD_STORAGE_KEY) ?? "";
    expect(JSON.parse(raw)).toEqual([card("a")]);
    expect(localStorage.length).toBe(0);
    expect(raw).not.toMatch(/"code"/);
    expect(readStoredGiftCards(sessionStorage, NOW)).toEqual([card("a")]);
  });

  it("applies at most five cards, in the order they were added", () => {
    let cards: StoredGiftCard[] = [];
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const result = addStoredGiftCard(cards, card(seed));
      if (!result.ok) throw new Error("expected room");
      cards = result.cards;
    }
    expect(addStoredGiftCard(cards, card("f"))).toEqual({ ok: false, reason: "limit" });
    expect(readStoredGiftCards(sessionStorage, NOW).map(({ handle: value }) => value)).toEqual(
      ["a", "b", "c", "d", "e"].map(handle),
    );
  });

  it("drops expired handles and malformed entries when reading", () => {
    sessionStorage.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify([
      card("a"),
      card("b", { handleExpiresAt: NOW - 1 }),
      { ...card("c"), handle: "XXXX-XXXX-XXXX-XXXX" },
      { ...card("d"), last4: "<b>" },
      "junk",
    ]));
    expect(readStoredGiftCards(sessionStorage, NOW)).toEqual([card("a")]);
  });

  it("removes a card and clears the key when none are left", () => {
    const cards = [card("a"), card("b")];
    writeStoredGiftCards(cards);
    expect(removeStoredGiftCards(cards, [handle("a")])).toEqual([card("b")]);
    expect(readStoredGiftCards(sessionStorage, NOW)).toEqual([card("b")]);
    clearStoredGiftCards();
    expect(sessionStorage.getItem(GIFT_CARD_STORAGE_KEY)).toBeNull();
  });

  it("is cleared with the checkout transfer once an order is placed", () => {
    writeStoredGiftCards([card("a")]);
    clearCheckoutTransferSession();
    expect(sessionStorage.getItem(GIFT_CARD_STORAGE_KEY)).toBeNull();
  });

  it("reads an apply response with an ISO handle expiry", () => {
    expect(readAppliedGiftCard({
      handle: handle("a"),
      handleExpiresAt: new Date(NOW + 7_200_000).toISOString(),
      last4: "7K2Q",
      balance: 500,
      balanceMinor: 50_000,
      currencyCode: "BDT",
      expiresAt: null,
    }, NOW)).toEqual(card("a", { handleExpiresAt: NOW + 7_200_000 }));
    expect(readAppliedGiftCard({ handle: "nope" }, NOW)).toBeNull();
  });
});

describe("giftCardRequestFields", () => {
  it("adds nothing without cards, so the old payload is unchanged", () => {
    expect(giftCardRequestFields(undefined)).toEqual({});
    expect(giftCardRequestFields([])).toEqual({});
    expect(giftCardRequestFields([{ handle: "not-a-handle" }])).toEqual({});
  });

  it("sends distinct handles only, at most five", () => {
    const handles = ["a", "b", "a", "c", "d", "e", "f"].map((seed) => ({ handle: handle(seed) }));
    expect(giftCardRequestFields(handles)).toEqual({
      giftCards: ["a", "b", "c", "d", "e"].map((seed) => ({ handle: handle(seed) })),
    });
    expect(giftCardRequestFields([card("a")])).toEqual({ giftCards: [{ handle: handle("a") }] });
  });
});

describe("giftCardQuoteRefusal", () => {
  const copy = giftCardCheckoutCopy();

  it("drops every card the quote names and says so once", () => {
    const refusal = giftCardQuoteRefusal([card("a"), card("b")], [
      { handle: handle("a"), code: "GIFT_CARD_UNUSABLE", message: "This gift card can't be used." },
    ], copy);
    expect(refusal.dropped).toEqual([handle("a")]);
    expect(refusal.remaining).toEqual([card("b")]);
    expect(refusal.message).toBe("This gift card can't be used.");
  });

  it("explains a card the other cards made unnecessary", () => {
    const refusal = giftCardQuoteRefusal([card("a"), card("b")], [
      { handle: handle("b"), code: "GIFT_CARD_NOT_NEEDED", message: "server words" },
    ], copy);
    expect(refusal.message).toBe(GIFT_CARD_CHECKOUT_COPY.giftCardNotNeededText);
    expect(refusal.remaining).toEqual([card("a")]);
  });

  it("keeps the cards for an order-level issue and ignores issues about other handles", () => {
    const refusal = giftCardQuoteRefusal([card("a")], [
      { handle: handle("z"), code: "GIFT_CARD_UNUSABLE", message: "x" },
      { handle: null, code: "SOMETHING_NEW", message: "Server explanation." },
    ], copy);
    expect(refusal).toEqual({ remaining: [card("a")], dropped: [], message: "Server explanation." });
    expect(giftCardQuoteRefusal([card("a")], undefined, copy).message).toBeNull();
  });
});

describe("giftCardCheckoutCopy", () => {
  it("defaults to the English checkout-language preset and follows the Bangla one", () => {
    for (const [key, value] of Object.entries(GIFT_CARD_CHECKOUT_COPY)) {
      expect(ENGLISH_CHECKOUT_LANGUAGE_DATA[key as keyof typeof ENGLISH_CHECKOUT_LANGUAGE_DATA], key).toBe(value);
    }
    const bangla = giftCardCheckoutCopy(BANGLA_CHECKOUT_LANGUAGE_DATA);
    expect(bangla.amountDueText).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.amountDueText);
    expect(bangla.giftCardUnusableText).not.toBe(GIFT_CARD_CHECKOUT_COPY.giftCardUnusableText);
  });

  it("takes the active language's strings over the English defaults", () => {
    const copy = giftCardCheckoutCopy({ amountDueText: "বাকি", giftCardApplyText: "  " });
    expect(copy.amountDueText).toBe("বাকি");
    expect(copy.giftCardApplyText).toBe(GIFT_CARD_CHECKOUT_COPY.giftCardApplyText);
  });
});

describe("requestGiftCardApply", () => {
  it("posts the normalized code in the body of a same-origin request, never in the URL", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      success: true,
      data: {
        handle: handle("a"),
        handleExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        last4: "7K2Q",
        balance: 500,
        balanceMinor: 50_000,
        currencyCode: "BDT",
        expiresAt: null,
      },
    }), { status: 200 }));
    const outcome = await requestGiftCardApply(" abcd-efgh-jkmn-7k2q ", fetchMock as typeof fetch);
    expect(outcome.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/gift-cards/apply");
    expect(String(url)).not.toMatch(/ABCD|abcd/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ code: "ABCDEFGHJKMN7K2Q" });
  });

  it("refuses input that cannot be a code without calling the proxy", async () => {
    const fetchMock = vi.fn();
    expect(await requestGiftCardApply("12", fetchMock as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, "unusable"],
    [429, "rate_limited"],
    [503, "unavailable"],
  ] as const)("maps a %s from the proxy to %s", async (status, reason) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status }));
    expect(await requestGiftCardApply("ABCDEFGHJKMN7K2Q", fetchMock as unknown as typeof fetch))
      .toEqual({ ok: false, reason });
  });
});
