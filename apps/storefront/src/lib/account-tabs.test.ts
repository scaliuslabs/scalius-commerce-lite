import { describe, expect, it, vi } from "vitest";
import { fetchAccountSummary, readAccountSummary, visibleAccountFeatureTabs } from "./account-tabs";

describe("account tabs", () => {
  it("shows no feature tab while the summary is unknown or every count is zero", () => {
    expect(visibleAccountFeatureTabs(null)).toEqual([]);
    expect(visibleAccountFeatureTabs(readAccountSummary({}))).toEqual([]);
  });

  it("shows each feature tab only while its count is above zero, in a fixed order", () => {
    const summary = readAccountSummary({ unreadInbox: 4, reviewsToWrite: 0, downloads: 2, giftCards: 0, activeWarranties: 1 });
    expect(visibleAccountFeatureTabs(summary).map((tab) => tab.href)).toEqual(["/account/downloads", "/account/warranties"]);
  });

  it("reads malformed counts as zero", () => {
    expect(readAccountSummary({ unreadInbox: "3", reviewsToWrite: -1, downloads: Number.NaN, giftCards: 2.7 })).toEqual({
      unreadInbox: 0, reviewsToWrite: 0, downloads: 0, giftCards: 2, activeWarranties: 0,
    });
    expect(readAccountSummary(null)).toBeNull();
  });

  it("reads the summary through the same-origin proxy and is null when it can't", async () => {
    const ok = vi.fn(async () => Response.json({ success: true, data: { unreadInbox: 1 } }));
    await expect(fetchAccountSummary(ok as unknown as typeof fetch)).resolves.toMatchObject({ unreadInbox: 1, downloads: 0 });
    expect(ok).toHaveBeenCalledWith("/api/customer-auth/account-summary", expect.objectContaining({ credentials: "same-origin" }));
    await expect(fetchAccountSummary((async () => new Response("", { status: 401 })) as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchAccountSummary((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toBeNull();
  });
});
