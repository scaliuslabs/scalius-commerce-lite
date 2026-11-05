import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createGiftCardCheckoutFixture, line, DELIVERY } from "../../../../../packages/core/src/testing/gift-card-checkout";
import { recordOrderReceipt, getCustomerOrderDetail } from "@scalius/core/modules/orders";
import { businessDocument, checkoutDocument } from "@scalius/core/modules/settings";
import { receiptRoutes } from "./receipt";

describe("manual deposit receipt", () => {
  it("requires order-specific proof and returns persisted instructions after checkout", async () => {
    const fixture = createGiftCardCheckoutFixture();
    try {
      await businessDocument.write(fixture.db, { phone: "+8801711111111", email: "saved@example.test" });
      const placed = await fixture.checkout({ ...DELIVERY, paymentMethod: "cod", items: [line("p_mug", "v_mug", 1, 300)] }, { codDeposit: { amount: 50, instructions: "Pay the saved account" } });
      await businessDocument.write(fixture.db, { phone: "+8801722222222", email: "changed@example.test" });
      await checkoutDocument.write(fixture.db, { codDepositInstructions: "Changed instructions" });
      const token = "chk_test_receipt_deposit_token";
      await recordOrderReceipt(fixture.db, { orderId: placed.orderId, token });
      const app = new OpenAPIHono();
      app.use("*", async (c, next) => { c.set("db" as never, fixture.db as never); await next(); });
      app.onError((error, c) => c.json({ error: error.message }, 404));
      app.route("/", receiptRoutes);
      const missing = await app.request(`/receipt/${placed.orderId}`);
      expect(missing.status).toBe(404);
      const wrongOrder = await app.request("/receipt/order_elsewhere", { headers: { "X-Receipt-Token": token } });
      expect(wrongOrder.status).toBe(404);
      const response = await app.request(`/receipt/${placed.orderId}`, { headers: { "X-Receipt-Token": token } }, {});
      const body = await response.json() as { data: { order: { paymentPlan: unknown } } };
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.data.order.paymentPlan).toMatchObject({ kind: "manual", status: "pending", depositAmount: 50, instructions: "Pay the saved account", contactSnapshot: { phone: "+8801711111111", email: "saved@example.test" } });
      fixture.sqlite.prepare("UPDATE orders SET account_owner_customer_id = customer_id WHERE id = ?").run(placed.orderId);
      const owner = fixture.one<{ customer_id: string }>("SELECT customer_id FROM orders WHERE id = ?", placed.orderId).customer_id;
      await expect(getCustomerOrderDetail(fixture.db, "wrong_customer", placed.orderId)).rejects.toThrow("Order not found");
      const detail = await getCustomerOrderDetail(fixture.db, owner, placed.orderId);
      expect(detail.paymentPlan).toMatchObject(body.data.order.paymentPlan!);
    } finally { fixture.close(); }
  });
});
