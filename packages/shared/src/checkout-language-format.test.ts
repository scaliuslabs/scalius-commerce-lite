import { describe, expect, it } from "vitest";
import { discountDisplayName, formatDiscountLineLabel } from "./checkout-language-format";

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
});
