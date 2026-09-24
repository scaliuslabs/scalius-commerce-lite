import { describe, expect, it } from "vitest";
import { customerFill, customerLookupTerm, findCustomerByPhone, type SavedCustomer } from "./customer-lookup";
import { toE164Phone } from "./types";

const saved: SavedCustomer = {
  name: "Rahim Uddin",
  email: "rahim@example.com",
  phone: "+8801712345678",
  address: "House 12, Road 5, Dhanmondi",
  city: "city_dhaka",
  zone: "zone_dhanmondi",
  area: null,
  totalOrders: 3,
};
const empty = { customerName: "", customerEmail: null, shippingAddress: "", city: "", zone: "", area: null };

describe("phone numbers typed on the order form", () => {
  it("reads a Bangladesh mobile in any spacing, prefix or Bangla digits", () => {
    for (const typed of ["01712345678", "01712-345678", "+880 1712 345678", "8801712345678", "০১৭১২৩৪৫৬৭৮"]) {
      expect(toE164Phone(typed)).toBe("+8801712345678");
    }
    expect(toE164Phone("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164Phone("+880 1234 5")).toBeNull();
    expect(toE164Phone("0171234")).toBeNull();
  });

  it("looks a customer up only once the number is complete", () => {
    expect(customerLookupTerm("0171234")).toBeNull();
    expect(customerLookupTerm("+880 1712-345678")).toBe("01712345678");
  });
});

describe("returning customer", () => {
  it("matches the exact number, not a partial search hit", () => {
    const other = { ...saved, phone: "+8801712345679" };
    expect(findCustomerByPhone([other, saved], "01712 345678")).toBe(saved);
    expect(findCustomerByPhone([other], "01712345678")).toBeNull();
  });

  it("fills only what the merchant left empty, with the saved address", () => {
    expect(customerFill(saved, empty, new Set(["city_dhaka"]))).toEqual({
      customerName: "Rahim Uddin",
      customerEmail: "rahim@example.com",
      shippingAddress: "House 12, Road 5, Dhanmondi",
      city: "city_dhaka",
      zone: "zone_dhanmondi",
      area: null,
    });
    expect(customerFill(saved, { ...empty, customerName: "Rahim bhai", city: "city_ctg" }, new Set(["city_dhaka"])))
      .toEqual({ customerEmail: "rahim@example.com", shippingAddress: "House 12, Road 5, Dhanmondi" });
  });

  it("skips a saved city that is no longer a delivery city", () => {
    expect(customerFill(saved, empty, new Set(["city_ctg"]))).not.toHaveProperty("city");
  });
});
