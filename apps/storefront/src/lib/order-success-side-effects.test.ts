import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("order success side effects", () => {
  it("gates cart cleanup and purchase tracking behind final payment state", () => {
    const pageSource = readFileSync(
      new URL("../pages/order-success.astro", import.meta.url),
      "utf8",
    );

    expect(pageSource).toContain("data-order-finalize");
    expect(pageSource).toContain("[data-order-finalize='true'][data-fb-order-details]");
    expect(pageSource.indexOf("[data-order-finalize='true'][data-fb-order-details]"))
      .toBeLessThan(pageSource.indexOf("clearCart();"));
  });

  it("keeps navigation buttons free of cart-clearing side effects", () => {
    const buttonsSource = readFileSync(
      new URL("../components/OrderSuccessButtons.tsx", import.meta.url),
      "utf8",
    );

    expect(buttonsSource).not.toContain("clearCart");
    expect(buttonsSource).not.toContain("@/store/cart");
  });
});
