import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { verifyStripeWebhook } from "./stripe";

describe("verifyStripeWebhook", () => {
  it("accepts an authentic event and rejects a tampered body", async () => {
    const secret = "whsec_test";
    const body = JSON.stringify({
      id: "evt_test",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test" } },
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret,
    });

    await expect(verifyStripeWebhook("sk_test", secret, body, signature))
      .resolves.toMatchObject({ id: "evt_test", type: "payment_intent.succeeded" });
    await expect(verifyStripeWebhook("sk_test", secret, `${body} `, signature))
      .resolves.toBeNull();
  });
});
