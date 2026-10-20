// Security audit S4: an app's pay-later method fails closed. A signed-in
// buyer is never simply eligible for it: it is gated until its own app's
// `checkout.payment_methods` allows it, so a slow or failing app hides it.
import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { DEFAULT_NET_TERMS_SETTINGS } from "@scalius/shared/payment-terms";
import { offeredDeferredMethods, resolveDeferredPaymentEligibility } from "./payment-terms";

const APP_METHOD = "acme.credit:invoice";
const providers = { isDeferred: (id: string) => id === APP_METHOD || id === "net_terms" };
// The app method needs no read: any query would throw.
const db = new Proxy({}, { get: () => { throw new Error("no read expected"); } }) as unknown as Database;

describe("deferred payment eligibility", () => {
  it("gates an app's deferred method for every signed-in buyer", async () => {
    const eligibility = await resolveDeferredPaymentEligibility(db, {
      enabledMethods: ["stripe", APP_METHOD],
      netTerms: DEFAULT_NET_TERMS_SETTINGS,
      customerId: "cus_attacker",
      providers,
    });
    expect([...eligibility.eligible]).toEqual([]);
    expect([...eligibility.gated]).toEqual([APP_METHOD]);
    // Listed for the app to answer; offered only after its allow (applyAppPaymentMethodOperations).
    expect([...offeredDeferredMethods(eligibility)]).toEqual([APP_METHOD]);
  });

  it("offers a guest no deferred method and reads nothing", async () => {
    const eligibility = await resolveDeferredPaymentEligibility(db, {
      enabledMethods: [APP_METHOD],
      netTerms: DEFAULT_NET_TERMS_SETTINGS,
      customerId: null,
      providers,
    });
    expect(eligibility.eligible.size + eligibility.gated.size).toBe(0);
  });
});
