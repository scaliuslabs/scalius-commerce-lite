import { describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { describeTimelineEvent } from "./order-timeline-display";

const t = (key: keyof typeof orderDetailMessages.en, vars?: Record<string, string | number>) =>
  translate(orderDetailMessages, key, vars);
const o = (key: keyof typeof orderMessages.en, vars?: Record<string, string | number>) =>
  translate(orderMessages, key, vars);
const money = (amount: number) => `৳${amount}`;
const describe_ = (kind: string, data: Record<string, unknown> | null = null, body: string | null = null) =>
  describeTimelineEvent({ kind: kind as never, data, body }, t, o, money);

describe("order timeline wording", () => {
  it("keeps the failed-delivery reason and the rider's note", () => {
    expect(describe_("cod_failed", { reason: "no_cash" }, "Will pay tomorrow")).toEqual({
      text: "Delivery failed: No cash",
      detail: "Will pay tomorrow",
    });
  });

  it("words a cancellation with its reason, and other moves with the new status", () => {
    expect(describe_("status_changed", { from: "pending", to: "cancelled", reason: "fake_order" })).toEqual({
      text: "Order cancelled",
      detail: "Fake order",
    });
    expect(describe_("status_changed", { from: "pending", to: "confirmed" }).text).toBe("Status changed to Confirmed");
  });

  it("shows money in the order's currency and the courier that took it", () => {
    expect(describe_("cod_collected", { amount: 3570, collectedBy: "Karim" })).toEqual({
      text: "৳3570 cash collected",
      detail: "Collected by Karim",
    });
    expect(describe_("shipment_created", { courierName: "Own rider", trackingId: "TRK-1" })).toEqual({
      text: "Sent with Own rider",
      detail: "Tracking ID TRK-1",
    });
    expect(describe_("refund_recorded", { amount: 500 }, "requested_by_customer")).toEqual({
      text: "৳500 refunded",
      detail: "Customer asked",
    });
  });

  it("shows a staff comment as written and a resolved request by name", () => {
    expect(describe_("comment", null, "Customer confirmed by phone at 3pm").text).toBe("Customer confirmed by phone at 3pm");
    expect(describe_("request_resolved", { type: "cancel_pre_shipment", status: "completed" }).text)
      .toBe("Cancellation requested · Done");
  });
});
