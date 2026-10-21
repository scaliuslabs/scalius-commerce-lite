// acme.wholesale in the SDK harness: every answer comes from the reads the
// host resolves (the buyer's membership, its company by one hop, per-SKU
// minimums and the products' own custom field), checked like production.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import wholesale from "./index";

const company = (data: Record<string, unknown>, revision = 3) => ({ revision, data: { name: "Acme Ltd", terms: "prepaid", prices: {}, approved_quotes: {}, ...data } });
const signedIn = { id: "cust_1", tags: [], orderCount: 0, totalSpentMinor: 0, roles: [] };
const cart = (lines: Array<{ variantId: string; productId: string; quantity: number }>, discountCodes: string[] = []) => fixtures.cart({
  customer: signedIn,
  discountCodes,
  lines: lines.map((line, index) => fixtures.cartLine({ ...line, lineId: `cart:${index}:${line.variantId}`, title: line.variantId, lineTotalMinor: 50_000 * line.quantity })),
});

describe("acme.wholesale", () => {
  const harness = createPluginTestHarness(wholesale);

  it("prices base-priced lines from the company's one price list", async () => {
    const result = await harness.fn("cart.line_prices", {
      cart: cart([{ variantId: "v_tea", productId: "p_tea", quantity: 1 }, { variantId: "v_mug", productId: "p_mug", quantity: 1 }]),
      lines: [{ lineId: "cart:0:v_tea", source: "base", bundle: null }, { lineId: "cart:1:v_mug", source: "sale", bundle: null }],
      reads: { member: { revision: 1, data: { company_id: "co_1" } }, company: company({ prices: { v_tea: 40_000, v_mug: 20_000 } }) },
    });
    expect(result.value).toEqual({ prices: [{ lineId: "cart:0:v_tea", unitPriceMinor: 40_000 }], adjustments: [] });
  });

  it("blocks a line under the higher of its SKU minimum and its product's field", async () => {
    const result = await harness.fn("cart.validate", {
      cart: cart([{ variantId: "v_tea", productId: "p_tea", quantity: 2 }, { variantId: "v_mug", productId: "p_mug", quantity: 5 }]),
      reads: { member: null, company: null, moq: { v_tea: { revision: 1, data: { min_qty: 2 } }, v_mug: { revision: 1, data: { min_qty: 3 } } }, fields: { p_tea: { revision: 0, data: { min_qty: 6 } } } },
    });
    expect(result.value).toEqual({ errors: [{ code: "moq", lineId: "cart:0:v_tea", message: "Order at least 6 of v_tea." }] });
  });

  it("keeps only the invoice method for a net-terms company", async () => {
    const methods = [{ methodId: "cod", name: "Cash" }, { methodId: "bkash", name: "bKash" }];
    const result = await harness.fn("checkout.payment_methods", { cart: cart([]), methods, reads: { company: company({ terms: "net30" }) } });
    expect(result.value).toEqual({ operations: [{ op: "hide", methodId: "bkash" }] });
    expect((await harness.fn("checkout.payment_methods", { cart: cart([]), methods, reads: { company: null } })).value).toEqual({ operations: [] });
  });

  it("spends an approved quote once: the discount and the company record without it commit together", async () => {
    const result = await harness.fn("checkout.discounts", {
      cart: cart([{ variantId: "v_tea", productId: "p_tea", quantity: 2 }], ["q-7"]),
      reads: { member: { revision: 1, data: { company_id: "co_1" } }, company: company({ approved_quotes: { "Q-7": 5_000, "Q-8": 900 } }) },
    });
    expect(result.value).toEqual({
      discounts: [{ title: "Quote Q-7", code: "Q-7", target: { kind: "order" }, value: { type: "fixed_amount", amountMinor: 5_000 } }],
      commit: [{ as: "company", record: { name: "Acme Ltd", terms: "prepaid", prices: {}, approved_quotes: { "Q-8": 900 } } }],
    });
  });
});
