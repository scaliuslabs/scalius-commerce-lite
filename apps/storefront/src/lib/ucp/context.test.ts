import { describe, expect, it } from "vitest";
import { resolveUcpPresence } from "./context";
import { UCP_TEST_MARKETS } from "./ucp-fixtures.testing";

describe("UCP buyer context to market presence", () => {
  it("answers a request without context at the root", () => {
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", undefined)).toEqual({ presence: "", messages: [] });
  });

  it("lets the country pick the market selling there, like checkout's shipping country", () => {
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "in" })).toEqual({ presence: "en-in", messages: [] });
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "BD" })).toEqual({ presence: "", messages: [] });
  });

  it("lets a currency pick a market selling in it when no country is given", () => {
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { currency: "usd" })).toEqual({ presence: "en-in", messages: [] });
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { currency: "BDT" })).toEqual({ presence: "", messages: [] });
  });

  it("picks the market's presence in the requested language", () => {
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "BD", language: "bn-BD" }).presence).toBe("bn");
    expect(resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { language: "bn" }).presence).toBe("bn");
  });

  it("falls back to the root market with a warning for a country no market sells to", () => {
    const resolution = resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "FR", currency: "EUR" });
    expect(resolution.presence).toBe("");
    expect(resolution.messages.map((message) => [message.type, message.code])).toEqual([
      ["warning", "market_unavailable"],
      ["warning", "currency_unavailable"],
    ]);
  });

  it("keeps the country's market and warns when it does not sell in the requested currency", () => {
    const resolution = resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "BD", currency: "USD" });
    expect(resolution.presence).toBe("");
    expect(resolution.messages).toEqual([
      { type: "warning", code: "currency_unavailable", content: "Prices are in BDT: this market does not sell in USD." },
    ]);
  });

  it("says when a market has no pages in the requested language", () => {
    const resolution = resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "IN", language: "fr" });
    expect(resolution.presence).toBe("en-in");
    expect(resolution.messages).toEqual([
      { type: "info", code: "language_unavailable", content: "Content is in en: this market has no fr pages." },
    ]);
  });

  it("does not echo an unreadable currency or country", () => {
    const resolution = resolveUcpPresence(UCP_TEST_MARKETS, "BDT", { address_country: "<script>", currency: "<b>" });
    expect(resolution.presence).toBe("");
    expect(JSON.stringify(resolution.messages)).not.toContain("<");
  });

  it("checks only the currency on a store whose API sends no presence matrix", () => {
    expect(resolveUcpPresence(undefined, "BDT", { address_country: "IN", language: "en" })).toEqual({ presence: "", messages: [] });
    expect(resolveUcpPresence(undefined, "BDT", { currency: "USD" }).messages.map((message) => message.code)).toEqual([
      "currency_unavailable",
    ]);
  });
});
