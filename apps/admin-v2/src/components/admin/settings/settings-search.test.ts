import { describe, expect, it } from "vitest";
import { searchSettings } from "./settings-search";

const firstCard = (query: string) => searchSettings(query).cards[0];

describe("settings search", () => {
  it("lists every page and no cards for an empty query", () => {
    const result = searchSettings("  ");
    expect(result.pages).toContain("payments");
    expect(result.cards).toEqual([]);
  });

  it("finds the card merchants mean by everyday words", () => {
    expect(firstCard("COD")).toEqual({ page: "payments", card: "paymentMethods" });
    expect(firstCard("bkash")).toEqual({ page: "payments", card: "paymentMethods" });
    expect(firstCard("courier")).toEqual({ page: "shipping", card: "couriers" });
    expect(firstCard("VAT")?.page).toBe("taxes");
    expect(firstCard("inside dhaka")).toEqual({ page: "shipping", card: "deliveryCharges" });
  });

  it("matches Bangla whatever the dashboard language", () => {
    expect(firstCard("বিকাশ")).toEqual({ page: "payments", card: "paymentMethods" });
    expect(firstCard("কুরিয়ার")?.page).toBe("shipping");
  });

  it("matches word starts only, so COD doesn't find unrelated words", () => {
    expect(searchSettings("cod").cards.every((entry) => entry.page === "payments")).toBe(true);
  });

  it("matches page names and summaries", () => {
    expect(searchSettings("taxes").pages).toEqual(["taxes"]);
    expect(searchSettings("zzz")).toEqual({ pages: [], cards: [] });
  });
});
