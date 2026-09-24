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

  it("tells shipping zones (pricing) from thanas (the address level Pathao calls a zone)", () => {
    const cards = (query: string) => searchSettings(query).cards.map((entry) => entry.card);
    expect(cards("shipping zone")).toEqual(["deliveryCharges"]);
    expect(cards("শিপিং জোন")).toEqual(["deliveryCharges"]);
    expect(cards("zone")).toEqual(["deliveryCharges", "deliveryAreas"]);
    expect(cards("thana")).toEqual(["deliveryAreas"]);
    expect(cards("থানা")).toEqual(["deliveryAreas"]);
    expect(cards("pathao zone")).toEqual(["deliveryAreas"]);
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
    expect(searchSettings("zzz")).toEqual({ pages: [], cards: [], shortcuts: [] });
  });

  const shortcuts = (query: string) => searchSettings(query).shortcuts.map((entry) => entry.card);

  it("finds My account security in English and Bangla", () => {
    for (const query of ["two-step", "2fa", "otp", "পাসওয়ার্ড", "টু-স্টেপ"]) {
      expect(shortcuts(query).length, query).toBeGreaterThan(0);
    }
    expect(shortcuts("two-step")).toEqual(["accountTwoStep"]);
    expect(shortcuts("2fa")).toEqual(["accountTwoStep"]);
    expect(shortcuts("password")).toEqual(["accountPassword"]);
    expect(shortcuts("পাসওয়ার্ড")).toEqual(["accountPassword"]);
    expect(shortcuts("sessions")).toEqual(["accountSessions"]);
    // Customer sign-in still answers "password" too.
    expect(searchSettings("password").cards).toContainEqual({ page: "customerAccounts", card: "customerSignIn" });
    expect(searchSettings("two-step").shortcuts[0]).toMatchObject({ to: "/admin/account", hash: "two-step" });
  });

  it("finds the store theme, dashboard language and light/dark mode", () => {
    expect(shortcuts("theme")).toEqual(["storeTheme", "dashboardAppearance"]);
    expect(shortcuts("থিম")).toEqual(["storeTheme", "dashboardAppearance"]);
    expect(shortcuts("language")).toEqual(["dashboardLanguage"]);
    expect(shortcuts("ভাষা")).toEqual(["dashboardLanguage"]);
    expect(searchSettings("dark mode").shortcuts[0]).not.toHaveProperty("to");
  });

  it("finds message templates and staff order emails in English and Bangla", () => {
    for (const query of ["SMS template", "message template", "টেমপ্লেট", "এসএমএস"]) {
      expect(shortcuts(query), query).toContain("messageTemplates");
    }
    for (const query of ["staff email", "new order alert", "স্টাফ ইমেইল"]) {
      expect(shortcuts(query), query).toContain("staffOrderEmails");
    }
    expect(shortcuts("order email")).toEqual(["messageTemplates", "staffOrderEmails"]);
    expect(searchSettings("template").shortcuts[0]).toMatchObject({
      to: "/admin/settings/notifications",
      hash: "customerNotifications",
    });
    expect(searchSettings("staff email").shortcuts[0]).toMatchObject({
      to: "/admin/settings/notifications",
      hash: "staffNotifications",
    });
  });

  it("finds where the Stripe webhook address is shown", () => {
    expect(firstCard("webhook")).toEqual({ page: "payments", card: "paymentMethods" });
  });

  it("keeps everyday matches", () => {
    for (const query of ["cod", "courier", "bkash", "vat", "sms", "কুরিয়ার", "বিকাশ"]) {
      expect(searchSettings(query).cards.length, query).toBeGreaterThan(0);
    }
  });
});
