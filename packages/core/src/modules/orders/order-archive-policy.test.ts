import { describe, expect, it } from "vitest";

import {
  getOrderArchiveStatusBlockedReason,
  isOrderArchiveStatusEligible,
} from "./order-archive-policy";

describe("order archive status policy", () => {
  it.each(["cancelled", "completed", "returned", "refunded"])(
    "allows finished status %s",
    (status) => {
      expect(isOrderArchiveStatusEligible(status)).toBe(true);
      expect(getOrderArchiveStatusBlockedReason(status)).toBeNull();
    },
  );

  it.each([
    "incomplete",
    "pending",
    "processing",
    "confirmed",
    "shipped",
    "delivered",
    "partially_refunded",
  ])("keeps operational status %s in the active workspace", (status) => {
    expect(isOrderArchiveStatusEligible(status)).toBe(false);
    expect(getOrderArchiveStatusBlockedReason(status)).toMatch(/before archiving/i);
  });
});
