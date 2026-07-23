import { describe, expect, it } from "vitest";
import {
  getShippingAddressError,
  MIN_SHIPPING_ADDRESS_LENGTH,
} from "./shipping-address";

describe("shipping address validation", () => {
  it("requires a non-empty address", () => {
    expect(getShippingAddressError("   ")).toBe(
      "Enter your delivery address.",
    );
  });

  it("matches the order API minimum after trimming", () => {
    expect(MIN_SHIPPING_ADDRESS_LENGTH).toBe(10);
    expect(getShippingAddressError(" short ")).toBe(
      "Enter a complete delivery address (at least 10 characters).",
    );
    expect(getShippingAddressError("Road 1, Dhanmondi")).toBeNull();
  });
});
