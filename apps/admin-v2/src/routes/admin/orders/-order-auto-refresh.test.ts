import { describe, expect, it } from "vitest";

import { getOrderAutoRefreshPauseReason } from "./-order-auto-refresh";

describe("order list auto-refresh activity", () => {
  it("runs only while the merchant is not selecting or acting on orders", () => {
    expect(getOrderAutoRefreshPauseReason({
      selectedCount: 0,
      actionDialogOpen: false,
      mutationInFlight: false,
    })).toBeNull();

    expect(getOrderAutoRefreshPauseReason({
      selectedCount: 2,
      actionDialogOpen: false,
      mutationInFlight: false,
    })).toBe("Auto-refresh is paused while orders are selected.");

    expect(getOrderAutoRefreshPauseReason({
      selectedCount: 0,
      actionDialogOpen: true,
      mutationInFlight: false,
    })).toBe("Auto-refresh is paused while an order action is open.");

    expect(getOrderAutoRefreshPauseReason({
      selectedCount: 0,
      actionDialogOpen: false,
      mutationInFlight: true,
    })).toBe("Auto-refresh is paused while an order action is saving.");
  });

  it("keeps the visible selection reason while a selected action is saving", () => {
    expect(getOrderAutoRefreshPauseReason({
      selectedCount: 1,
      actionDialogOpen: true,
      mutationInFlight: true,
    })).toBe("Auto-refresh is paused while orders are selected.");
  });
});
