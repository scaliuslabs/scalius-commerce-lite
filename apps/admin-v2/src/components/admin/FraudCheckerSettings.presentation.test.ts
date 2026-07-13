import { describe, expect, it } from "vitest";
import { getFraudProviderMarkId } from "./fraud-provider-presentation";

describe("fraud provider identity", () => {
  it("maps reviewed providers to exact marks and leaves custom endpoints neutral", () => {
    expect(getFraudProviderMarkId("fraudbd")).toBe("fraudbd");
    expect(getFraudProviderMarkId("fraudguard")).toBeNull();
    expect(getFraudProviderMarkId("ecourier")).toBe("ecourier");
    expect(getFraudProviderMarkId("default")).toBeNull();
    expect(getFraudProviderMarkId(undefined)).toBeNull();
  });
});
