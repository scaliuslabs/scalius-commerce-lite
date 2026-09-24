import { describe, expect, it } from "vitest";
import { rateErrors } from "./DeliveryZones";

const rate = (patch: Partial<Parameters<typeof rateErrors>[0]> = {}) => ({
  key: "k",
  id: null,
  kind: "delivery" as const,
  name: "Inside Dhaka",
  fee: "60",
  freeOver: "",
  description: "",
  pickupAddress: "",
  pickupHours: "",
  isActive: true,
  ...patch,
});

describe("delivery charge validation", () => {
  it("accepts Bangla digits and an empty free-over amount", () => {
    expect(rateErrors(rate({ fee: "৬০.৫০" }))).toEqual({});
  });

  it("bounds the charge and the free-over amount at ৳1,00,000", () => {
    expect(rateErrors(rate({ fee: "99999999999" }))).toEqual({ fee: "feeTooHigh" });
    expect(rateErrors(rate({ fee: "100000", freeOver: "100000.01" }))).toEqual({ freeOver: "freeOverTooHigh" });
    expect(rateErrors(rate({ fee: "60.555", freeOver: "abc" }))).toEqual({ fee: "feeInvalid", freeOver: "feeInvalid" });
  });

  it("treats an empty pickup charge as free, but still needs a delivery charge", () => {
    expect(rateErrors(rate({ kind: "pickup", fee: "", pickupAddress: "House 1, Dhanmondi" }))).toEqual({});
    expect(rateErrors(rate({ kind: "pickup", fee: "abc", pickupAddress: "House 1, Dhanmondi" }))).toEqual({ fee: "feeInvalid" });
    expect(rateErrors(rate({ fee: "" }))).toEqual({ fee: "feeInvalid" });
  });

  it("needs a name and, for pickup, the pickup address", () => {
    expect(rateErrors(rate({ name: " ", kind: "pickup", fee: "0" }))).toEqual({
      name: "rateNameRequired",
      pickupAddress: "pickupAddressRequired",
    });
  });
});
