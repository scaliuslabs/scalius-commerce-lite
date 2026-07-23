import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const cartSource = readFileSync(storefrontSourcePath("pages/cart.astro"), "utf8");

describe("cart shipping address boundary", () => {
  it("blocks an API-invalid address before the payment handoff", () => {
    expect(cartSource).toContain("minLength={MIN_SHIPPING_ADDRESS_LENGTH}");
    expect(cartSource).toContain('aria-describedby="shippingAddressError"');
    expect(cartSource).toContain("getShippingAddressError");
    expect(cartSource).toContain("syncShippingAddressValidity(true)");
    expect(cartSource).toContain('id="shippingLocationError"');
    expect(cartSource).toContain("Choose a city and zone to continue.");
    expect(cartSource).toContain("Choose a zone to continue.");
    expect(cartSource).not.toContain('"city",\n          "zone",');
    expect(cartSource.indexOf("syncShippingAddressValidity(true)")).toBeLessThan(
      cartSource.indexOf("writeCheckoutTransferSession("),
    );
  });
});
