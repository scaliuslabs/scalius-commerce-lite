import { describe, expect, it } from "vitest";
import { parseAbandonedCheckoutDisplay } from "@/lib/abandoned-checkout-display";
import { orderListMessages } from "~/i18n/order-list";
import { abandonedStage } from "./abandoned-stage";

const stageOf = (data: Record<string, unknown>, customerPhone: string | null = null) =>
  abandonedStage(parseAbandonedCheckoutDisplay({ id: "a", checkoutId: "chk_1", customerPhone, checkoutData: JSON.stringify(data) }));

const cart = { cart: { items: [{ id: "i", name: "Kurta", quantity: 1, price: 800 }], totalAmount: 800 } };

describe("abandoned checkout progress", () => {
  it("says Details entered only when there is a name or a phone", () => {
    expect(stageOf({ ...cart, customerName: "Laila" }).label).toBe("infoCaptured");
    expect(stageOf(cart, "01712345678").label).toBe("infoCaptured");
  });

  it("words a row with no name and no phone from what is there", () => {
    expect(stageOf({ ...cart, shippingAddress: "House 4, Road 2" }).label).toBe("addressEntered");
    expect(stageOf({ ...cart, customerEmail: "laila@example.com" }).label).toBe("emailEntered");
    expect(stageOf({ ...cart, notes: "Call first" })).toEqual({ label: "cartStarted", variant: "secondary" });
    expect(stageOf({ notes: "Call first" })).toEqual({ label: "sessionCreated", variant: "outline" });
  });

  it("has every label in both languages", () => {
    for (const label of ["infoCaptured", "addressEntered", "emailEntered", "cartStarted", "sessionCreated", "paymentNotFinished", "unreadable"] as const) {
      expect(orderListMessages.en[`stage.${label}`]).toBeTruthy();
      expect(orderListMessages.bn[`stage.${label}`]).toBeTruthy();
    }
  });
});
