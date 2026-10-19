import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import notes from "./index";

const buyer = {
  target: "purchase.checkout.contact.render-after" as const, language: "en", locale: "en-BD", currency: "BDT",
  cart: null, attributes: {}, order: null, customer: null,
};

describe("acme.notes buyer UI", () => {
  it("draws the declared delivery field and keeps text as data", async () => {
    const harness = createPluginTestHarness(notes, { settings: { delivery_note: "<script>alert(1)</script>" } });
    expect((await harness.fn("buyer.ui", buyer)).value).toEqual({ ui: { type: "stack", children: [
      { type: "text", text: "<script>alert(1)</script>" },
      { type: "field", attribute: "delivery_instructions" },
    ] } });
    expect(harness.manifest.routes.public).toEqual([]);
  });

  it("reads account text only from the buyer's declared read", async () => {
    const harness = createPluginTestHarness(notes);
    const input = { ...buyer, target: "customer-account.order-index.block.render" as const, customer: { id: "cust_1" } };
    expect((await harness.fn("buyer.ui", { ...input, reads: { note: { revision: 2, data: { text: "Your next delivery is on Friday." } } } })).value)
      .toEqual({ ui: { type: "text", text: "Your next delivery is on Friday." } });
    expect((await harness.fn("buyer.ui", { ...input, reads: { note: null } })).value)
      .toEqual({ ui: { type: "text", text: "Earn points on every order." } });
  });
});
