import { describe, expect, it } from "vitest";
import { checkoutLanguageBaseCode, discountDisplayName, formatDiscountLineLabel } from "./checkout-language-format";
import { checkoutLanguageBaseCode as catalogBaseCode } from "./checkout-language";

describe("checkout language base code", () => {
  it("is the code's base language, English when there is none, and the one checkout-language re-exports", () => {
    expect(checkoutLanguageBaseCode("bn-BD")).toBe("bn");
    expect(checkoutLanguageBaseCode(" BN_bd ")).toBe("bn");
    expect(checkoutLanguageBaseCode("en")).toBe("en");
    expect(checkoutLanguageBaseCode("")).toBe("en");
    expect(checkoutLanguageBaseCode("-x")).toBe("en");
    expect(checkoutLanguageBaseCode(undefined)).toBe("en");
    expect(checkoutLanguageBaseCode(7)).toBe("en");
    expect(catalogBaseCode).toBe(checkoutLanguageBaseCode);
  });
});

describe("discount names", () => {
  it("adds the code in brackets only when it differs from the title, in any letter case", () => {
    expect(discountDisplayName({ title: "Eid sale", code: "EID10" })).toBe("Eid sale (EID10)");
    expect(discountDisplayName({ title: "R3-ORDER10", code: "R3-ORDER10" })).toBe("R3-ORDER10");
    expect(discountDisplayName({ title: "r3-order10", code: "R3-ORDER10" })).toBe("r3-order10");
    expect(discountDisplayName({ title: "", code: "SAVE5" })).toBe("SAVE5");
    expect(discountDisplayName({ title: "Weekend deal", code: null })).toBe("Weekend deal");
  });

  it("puts the buyer's word for a discount before the name", () => {
    expect(formatDiscountLineLabel("ছাড়", { title: "R3-ORDER10", code: "R3-ORDER10" })).toBe("ছাড় · R3-ORDER10");
    expect(formatDiscountLineLabel("Discount", { title: "", code: null })).toBe("Discount");
  });

  it("shows buyers a code discount by its code and an automatic one by its title, never a staff name", () => {
    // "fao" is the name staff gave the EID2027 code discount.
    expect(formatDiscountLineLabel("Discount", { title: "fao", code: "EID2027" })).toBe("Discount · EID2027");
    expect(formatDiscountLineLabel("Discount", { title: "r3-order10", code: "R3-ORDER10" })).toBe("Discount · R3-ORDER10");
    expect(formatDiscountLineLabel("Discount", { title: "Eid sale", code: null })).toBe("Discount · Eid sale");
    // A store app names its own discounts for buyers.
    expect(formatDiscountLineLabel("Discount", { title: "Members save 5%", code: "VIP", appId: "acme.members" }))
      .toBe("Discount · Members save 5% (VIP)");
    // Staff still see the name beside the code.
    expect(discountDisplayName({ title: "fao", code: "EID2027" })).toBe("fao (EID2027)");
  });
});
