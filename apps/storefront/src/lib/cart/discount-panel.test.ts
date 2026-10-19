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

  it("shows an earned free gift as a headline, its title and one compact row per item", () => {
    const root = panel();
    const added: number[] = [];
    const long = "Xiaozhi Electronic Pet AI Chatbot Emotional Companion Smart Voice Interactive Robot Virtual Partner";
    const facts = parseDiscountFacts({
      offers: [{
        promotionId: "p_gift", title: "Eid gift", code: null, kind: "get", percentOff: 100, quantity: 1, shortfallAmount: null,
        products: [
          { id: "p_a", slug: "a", name: "Cap", variantId: "v_a", price: 200 },
          { id: "p_b", slug: "robot", name: long, variantId: null, price: null },
          { id: "p_c", slug: "mug", name: "Mug", variantId: null, price: null },
        ],
      }],
    });
    renderDiscountPanel(root, { codes: [], facts }, ENGLISH_CHECKOUT_LANGUAGE_DATA, { ...actions, addOfferProduct: (_offer, index) => added.push(index) });

    const offer = root.querySelector("#discountOffers > li")!;
    expect(offer.querySelector("p.font-medium")?.textContent).toBe("Choose your free gift");
    expect(offer.textContent).toContain("Eid gift");
    // No "Add A / B / C" sentence and no long name inside a button.
    expect(offer.textContent).not.toContain(" / ");
    const rows = [...offer.querySelectorAll("ul > li")];
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual(["Cap", long, "Mug"]);
    expect(rows[1]!.querySelector("span")!.className).toContain("truncate");
    expect(rows[1]!.querySelector("span")!.getAttribute("title")).toBe(long);
    const robot = rows[1]!.querySelector("a")!;
    expect(robot.textContent).toBe("Choose options");
    expect(robot.getAttribute("aria-label")).toBe(`Choose options: ${long}`);
    expect(robot.getAttribute("href")).toBe("/products/robot");
    expect(robot.className).toContain("whitespace-nowrap");
    rows[0]!.querySelector("button")!.click();
    expect(added).toEqual([0]);
  });

  it("names how many items and how much off a percentage offer gives", () => {
    const root = panel();
    const facts = parseDiscountFacts({
      offers: [{
        promotionId: "p_pair", title: "Pair deal", code: null, kind: "get", percentOff: 20, quantity: 2, shortfallAmount: null,
        products: [{ id: "p_a", slug: "a", name: "Cap", variantId: "v_a", price: 200 }],
      }],
    });
    renderDiscountPanel(root, { codes: [], facts }, ENGLISH_CHECKOUT_LANGUAGE_DATA, actions);
    expect(root.querySelector("#discountOffers p.font-medium")?.textContent).toBe("Choose 2 items at 20% off");
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
