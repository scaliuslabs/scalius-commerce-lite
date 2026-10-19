// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { renderDiscountPanel } from "./discount-panel";
import { parseDiscountFacts } from "../checkout/tax-quote-contract";

function panel() {
  const root = document.createElement("div");
  root.innerHTML = `<div id="discountLines"></div><ul id="appliedCodes"></ul><ul id="discountOffers"></ul>`;
  return root;
}

const actions = { removeCode() {}, addOfferProduct() {}, focusPhone() {} };

describe("discount panel: which discount applies", () => {
  it("says a code replaced the automatic discount because it saves more, once", () => {
    const root = panel();
    const facts = parseDiscountFacts({
      discounts: [{ promotionId: "p_save", title: "Save 10", code: "SAVE10", amount: 250, shippingAmount: 0, replaces: "Eid 5%" }],
    });
    renderDiscountPanel(root, { codes: ["SAVE10"], facts }, ENGLISH_CHECKOUT_LANGUAGE_DATA, actions);

    const notes = [...root.querySelectorAll("#appliedCodes li.basis-full")].map((note) => note.textContent);
    expect(notes).toEqual(["SAVE10 gives a bigger discount than Eid 5%, so SAVE10 is applied."]);
    expect(root.querySelector("#discountLines")?.textContent).toContain("Discount · SAVE10");
    expect(root.querySelector("#discountLines")?.textContent).not.toContain("Eid 5%");
  });

  it("names the discount that applies instead of a weaker code", () => {
    const root = panel();
    const facts = parseDiscountFacts({
      discounts: [{ promotionId: "p_eid", title: "Eid 20%", code: null, amount: 500, shippingAmount: 0 }],
      rejectedCodes: [{ code: "TEN", reason: "lower_savings", message: "…", conflictsWith: "Eid 20%" }],
    });
    renderDiscountPanel(root, { codes: ["TEN"], facts }, ENGLISH_CHECKOUT_LANGUAGE_DATA, actions);

    const notes = [...root.querySelectorAll("#appliedCodes li.basis-full")].map((note) => note.textContent);
    expect(notes).toEqual(["TEN: Eid 20% gives an equal or bigger discount, so Eid 20% is applied."]);
  });

  it("names the bundle saving that beat a code, and keeps the code", () => {
    const root = panel();
    const facts = parseDiscountFacts({
      discounts: [],
      rejectedCodes: [{ code: "SAVE5", reason: "lower_savings", message: "…", conflictsWith: "Bundle saving", bundleSavesMore: true }],
    });
    expect(facts.rejectedCodes[0]).toMatchObject({ bundleSavesMore: true });
    renderDiscountPanel(root, { codes: ["SAVE5"], facts }, ENGLISH_CHECKOUT_LANGUAGE_DATA, actions);
    const notes = [...root.querySelectorAll("#appliedCodes li.basis-full")].map((note) => note.textContent);
    expect(notes).toEqual(["SAVE5: Bundle saving applied: better than SAVE5."]);
  });

  it("lists a store app's discount (no promotion) like any other, keyed by its app and position", () => {
    const root = panel();
    // The cart preview (`/discounts/validate`) may now answer with an app's line.
    const facts = parseDiscountFacts({
      discounts: [
        { promotionId: "p_eid", appId: null, title: "Eid 5%", code: null, amount: 50, shippingAmount: 0 },
        { promotionId: null, appId: "app_loyalty", title: "<i>Loyalty</i> reward", code: null, amount: 30, shippingAmount: 0 },
        { promotionId: null, appId: "app_loyalty", title: "Free delivery", code: null, amount: 0, shippingAmount: 60 },
      ],
    });
    renderDiscountPanel(root, { codes: [], facts }, ENGLISH_CHECKOUT_LANGUAGE_DATA, actions);

    const rows = [...root.querySelectorAll<HTMLElement>("#discountLines > div")];
    expect(rows.map((row) => row.dataset.discountLine)).toEqual(["p_eid", "app:app_loyalty:1"]);
    expect(rows[1]?.textContent).toContain("Discount · <i>Loyalty</i> reward");
    expect(rows[1]?.querySelector("i")).toBeNull();
  });
});
