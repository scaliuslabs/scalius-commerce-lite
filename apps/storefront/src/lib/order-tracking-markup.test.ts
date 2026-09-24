// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA as bn } from "@scalius/shared/checkout-language";
import {
  orderProgressMarkup,
  orderShipmentMarkup,
  orderTimelineMarkup,
  safeTrackingUrl,
  type OrderTrackingText,
} from "./order-tracking-markup";

const text: OrderTrackingText = {
  done: bn.orderTrackingStepDoneText,
  trackingId: bn.orderTrackingIdText,
  trackWithCourier: bn.orderTrackWithCourierText,
  formatDate: (iso) => iso.slice(0, 10),
};

function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("order tracking markup", () => {
  it("marks finished steps and the current one in the store's language", () => {
    const host = render(orderProgressMarkup({
      steps: [
        { key: "placed", label: "অর্ডার দেওয়া হয়েছে", done: true, happenedAt: null },
        { key: "confirmed", label: "নিশ্চিত", done: true, happenedAt: null },
        { key: "shipped", label: "পথে", done: false, happenedAt: null },
        { key: "delivered", label: "ডেলিভারি", done: false, happenedAt: null },
      ],
      outcome: null,
    }, text));
    const steps = [...host.querySelectorAll("li")];
    expect(steps.map((step) => step.textContent?.trim())).toEqual(["অর্ডার দেওয়া হয়েছে (সম্পন্ন)", "নিশ্চিত", "পথে", "ডেলিভারি"]);
    expect(steps[1]?.getAttribute("aria-current")).toBe("step");
  });

  it("escapes timeline text and dates each update", () => {
    const host = render(orderTimelineMarkup([
      { id: "t1", type: "order", status: "shipped", label: "<b>Shipped</b>", happenedAt: "2026-09-24T03:00:00.000Z", details: null },
    ], text));
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent?.replace(/\s+/g, " ").trim()).toBe("<b>Shipped</b> 2026-09-24");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-24T03:00:00.000Z");
  });

  it("links a courier only over http(s), and never a relative link without a base", () => {
    expect(safeTrackingUrl("javascript:alert(1)")).toBeNull();
    expect(safeTrackingUrl("/t/TRK-9")).toBeNull();
    expect(safeTrackingUrl("/t/TRK-9", "https://shop.example")).toBe("https://shop.example/t/TRK-9");
    const host = render(orderShipmentMarkup({
      statusLabel: "পথে", courier: "Pathao", trackingId: "TRK-9", trackingUrl: safeTrackingUrl("https://courier.example/t/TRK-9"),
    }, text));
    expect(host.textContent?.replace(/\s+/g, " ").trim()).toBe(`পথে · Pathao ${bn.orderTrackingIdText} TRK-9 ${bn.orderTrackWithCourierText}`);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://courier.example/t/TRK-9");
    expect(host.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
