// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("./country-address", async (load) => {
  const actual = await load<typeof import("./country-address")>();
  return {
    ...actual,
    loadAddressRules: vi.fn(async (countryCode: string) => ({
      countryCode,
      allowedFields: countryCode === "BD" ? ["name", "line1", "locality"] : ["name", "line1", "adminArea", "postalCode"],
      requiredFields: countryCode === "BD" ? [] : ["postalCode"],
      postalCodeExamples: [],
      rows: [["name"], ["line1"], ["locality", "adminArea", "postalCode"]],
      adminAreas: [],
    })),
  };
});

import { enhanceBillingAddress } from "./billing-address-rules";

function render(country: string) {
  document.body.innerHTML = `<section data-billing-section><h2>Billing address</h2>
    <div data-billing-fields><input type="hidden" name="billingCountryCode" value="${country}">
      <div data-address-rule="adminArea"><input></div><div data-address-rule="postalCode"><input></div>
    </div></section>`;
  return document.querySelector<HTMLElement>("[data-billing-section]")!;
}

describe("billing address section", () => {
  it("hides the whole section when the one country's minimal billing address asks nothing", async () => {
    const section = render("BD");
    enhanceBillingAddress(document, { readMode: () => "minimal" });
    await vi.waitFor(() => expect(section.hidden).toBe(true));
  });

  it("keeps the section while a field is asked", async () => {
    const section = render("US");
    enhanceBillingAddress(document, { readMode: () => "minimal" });
    await vi.waitFor(() => expect(section.querySelector<HTMLElement>('[data-address-rule="postalCode"]')!.hidden).toBe(false));
    expect(section.hidden).toBe(false);
  });
});
