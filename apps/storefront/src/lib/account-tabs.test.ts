import { describe, expect, it } from "vitest";
import { accountNavTabs, readAccountSummary } from "./account-tabs";

const keys = (tabs: ReturnType<typeof accountNavTabs>) => tabs.map((tab) => tab.key);

describe("account navigation", () => {
  it("always shows Orders, Profile and Inbox, even while the summary is unknown", () => {
    expect(keys(accountNavTabs("orders", null))).toEqual(["orders", "profile", "inbox"]);
  });

  it("shows a feature tab while it has something, in a fixed order, with the badges", () => {
    const summary = readAccountSummary({ unreadInbox: 4, reviewsToWrite: 0, reviewsWritten: 2, downloads: 2, giftCards: 0, activeWarranties: 1 });
    const tabs = accountNavTabs("orders", summary);
    expect(keys(tabs)).toEqual(["orders", "profile", "inbox", "reviews", "downloads", "warranties"]);
    expect(tabs.find((tab) => tab.key === "inbox")?.badge).toBe("4");
    // Written reviews keep the tab; only reviews still to write earn a badge.
    expect(tabs.find((tab) => tab.key === "reviews")?.badge).toBe("");
    expect(accountNavTabs("orders", readAccountSummary({ reviewsToWrite: 120 })).find((tab) => tab.key === "reviews")?.badge).toBe("99+");
  });

  it("keeps the current page's tab at zero, so a buyer is never on a page without its tab", () => {
    expect(keys(accountNavTabs("gift-cards", readAccountSummary({})))).toEqual(["orders", "profile", "inbox", "gift-cards"]);
    expect(keys(accountNavTabs("warranties", readAccountSummary({})))).toEqual(["orders", "profile", "inbox", "warranties"]);
  });

  it("reads malformed counts as zero", () => {
    expect(readAccountSummary({ unreadInbox: "3", reviewsToWrite: -1, downloads: Number.NaN, giftCards: 2.7 })).toEqual({
      unreadInbox: 0, reviewsToWrite: 0, reviewsWritten: 0, downloads: 0, giftCards: 2, activeWarranties: 0,
    });
    expect(readAccountSummary(null)).toBeNull();
  });
});
