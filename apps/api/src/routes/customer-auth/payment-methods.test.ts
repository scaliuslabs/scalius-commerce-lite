// Security audit N3: a buyer sees and removes their own saved payment
// methods in their account (and never another buyer's). Real routes on the
// migrated SQLite schema (the conversation harness).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationHarness, OTHER_SESSION, OWNER_SESSION, type Harness } from "../__tests__/conversation-harness";

let harness: Harness;

beforeEach(async () => {
  harness = await createConversationHarness();
  harness.sqlite.exec(`
    INSERT INTO customer_payment_methods (id, customer_id, provider_id, provider_method_ref, brand, last4, expiry_month, expiry_year,
        source_order_id, owner_plugin_id, purchase_option_id, purchase_option_title, created_at)
      VALUES ('cpm_owner', 'cust_owner', 'acme.gone:card', 'pm_secret_ref', 'visa', '4242', 12, 2030,
        'ORDEROWNED000001', 'acme.subs', 'acme.subs.monthly', 'Subscribe and save', 1),
             ('cpm_other', 'cust_other', 'acme.gone:card', 'pm_other_ref', 'mastercard', '5555', 1, 2031, NULL, NULL, NULL, NULL, 2);
  `);
});
afterEach(() => harness.sqlite.close());

describe("the buyer's saved payment methods", () => {
  it("lists only the buyer's own methods, with what each was kept for and never the provider reference", async () => {
    const response = await harness.request("/customer-auth/payment-methods", { session: OWNER_SESSION });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const text = await response.text();
    expect(text).not.toContain("pm_secret_ref");
    expect(text).not.toContain("acme.subs");
    expect(JSON.parse(text).data).toEqual({ paymentMethods: [{
      id: "cpm_owner", brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2030, label: null,
      savedFor: "Subscribe and save", createdAt: new Date(1000).toISOString(),
    }] });
  });

  it("removes the buyer's own method and refuses another buyer's", async () => {
    const other = await harness.request("/customer-auth/payment-methods/cpm_other", { method: "DELETE", session: OWNER_SESSION });
    expect(other.status).toBe(404);
    expect(harness.sqlite.prepare("SELECT status FROM customer_payment_methods WHERE id = 'cpm_other'").get()).toEqual({ status: "active" });

    const removed = await harness.request("/customer-auth/payment-methods/cpm_owner", { method: "DELETE", session: OWNER_SESSION });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { data: unknown }).data).toEqual({ paymentMethods: [] });
    expect(harness.sqlite.prepare("SELECT status FROM customer_payment_methods WHERE id = 'cpm_owner'").get()).toEqual({ status: "removed" });

    const otherList = await harness.request("/customer-auth/payment-methods", { session: OTHER_SESSION });
    expect((await otherList.json() as { data: { paymentMethods: Array<{ id: string }> } }).data.paymentMethods.map((method) => method.id)).toEqual(["cpm_other"]);
  });

  it("requires a customer session", async () => {
    expect((await harness.request("/customer-auth/payment-methods")).status).toBe(401);
  });
});
