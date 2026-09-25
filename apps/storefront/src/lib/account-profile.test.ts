import { describe, expect, it } from "vitest";
import { addressErrors, nameError, profileSavedText, readProfileForm, readProfileSavedFlag } from "./account-profile";

const locations = {
  cities: [{ id: "city_dhaka", name: "Dhaka" }, { id: "city_ctg", name: "Chattogram" }],
  zones: [{ id: "zone_mirpur", name: "Mirpur" }],
  areas: [{ id: "area_1", name: "Mirpur 1" }],
};
const draft = { address: "House 1, Road 2, Block C", city: "city_dhaka", zone: "zone_mirpur", area: "" };

describe("account profile forms", () => {
  it("reads only known intents and trims the posted fields", () => {
    const form = new FormData();
    form.set("intent", "address");
    form.set("address", "  House 1, Road 2  ");
    form.set("city", "city_dhaka");
    expect(readProfileForm(form)).toMatchObject({ intent: "address", draft: { address: "House 1, Road 2", city: "city_dhaka", zone: "", area: "" } });
    form.set("intent", "delete-account");
    expect(readProfileForm(form).intent).toBeNull();
  });

  it("never saves a blank name", () => {
    expect(nameError("  ")).toBe("Enter your full name.");
    expect(nameError("Rafi Ahmed")).toBeNull();
  });

  it("checks an address like checkout, against the store's live locations", () => {
    expect(addressErrors(draft, locations)).toEqual({});
    expect(addressErrors({ ...draft, address: "Short" }, locations)).toHaveProperty("address");
    expect(addressErrors({ ...draft, city: "" }, locations)).toEqual({ city: "Choose a city." });
    expect(addressErrors({ ...draft, area: "area_elsewhere" }, locations)).toHaveProperty("area");
    expect(addressErrors({ ...draft, area: "area_1" }, locations)).toEqual({});
  });

  it("asks for a thana when the city changed without JavaScript (the old thana is not in the new city)", () => {
    expect(addressErrors({ ...draft, city: "city_ctg" }, { ...locations, zones: [{ id: "zone_panchlaish", name: "Panchlaish" }] }))
      .toEqual({ zone: expect.any(String) });
  });

  it("puts only an outcome flag in the URL", () => {
    expect(readProfileSavedFlag(new URLSearchParams("saved=address"))).toBe("address");
    expect(readProfileSavedFlag(new URLSearchParams("saved=<script>"))).toBeNull();
    expect(profileSavedText("removed")).toBe("Address removed.");
  });
});
