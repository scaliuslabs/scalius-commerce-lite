import { describe, expect, it } from "vitest";

import {
  getOrderArchiveStatusBlockedReason,
  isOrderArchiveStatusEligible,
} from "./order-archive-policy";

describe("order archive status policy", () => {
  it.each(["cancelled", "delivered", "completed", "returned", "refunded"])(
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
  ])("keeps open status %s in the active workspace, and says why", (status) => {
    expect(isOrderArchiveStatusEligible(status)).toBe(false);
    expect(getOrderArchiveStatusBlockedReason(status)).toBe(
      "Only finished orders can be archived: delivered, cancelled, returned or refunded.",
    );
  });
});
