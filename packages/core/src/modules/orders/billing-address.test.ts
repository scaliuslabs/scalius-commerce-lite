import { describe, expect, it } from "vitest";

import { BILLING_ADDRESS_INVALID_REASON, BILLING_ADDRESS_REQUIRED_REASON, BILLING_COUNTRY_UNAVAILABLE_REASON } from "@scalius/shared/billing-address";
import {
    billingTaxLocation,
    orderBillingAddressColumns,
    orderBillingAddressInsertColumns,
    resolveCheckoutBillingAddress,
    resolveStaffBillingAddress,
} from "./billing-address";
import { formatOrderBillingAddress } from "./billing-display";

const selling = ["BD", "DE", "US"];

describe("resolveCheckoutBillingAddress", () => {
    it("bills an order that ships at its shipping address unless the buyer sent another", () => {
        expect(resolveCheckoutBillingAddress({}, { path: "delivery", requireFullBillingAddress: false, sellingCountries: selling }))
            .toEqual({ sameAsShipping: true, address: null });
        // Not asked: whatever was sent, the shipping address bills.
        expect(resolveCheckoutBillingAddress({ billingSameAsShipping: false, billingCountryCode: "US" }, { path: "delivery", requireFullBillingAddress: false, sellingCountries: selling }))
            .toEqual({ sameAsShipping: true, address: null });
        const separate = resolveCheckoutBillingAddress({
            billingSameAsShipping: false,
            billingCountryCode: "US",
            billingAddress: "1 Main St",
            billingLocality: "Springfield",
            billingAdminArea: "Illinois",
            billingPostalCode: "62701",
        }, { path: "delivery", requireFullBillingAddress: true, sellingCountries: selling });
        expect(separate.sameAsShipping).toBe(false);
        expect(separate.address).toMatchObject({ countryCode: "US", line1: "1 Main St", adminArea: "IL", postalCode: "62701" });
        // Unticked with nothing sent, when the merchant asks: refused.
        expect(() => resolveCheckoutBillingAddress({ billingSameAsShipping: false }, { path: "delivery", requireFullBillingAddress: true, sellingCountries: selling }))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: BILLING_ADDRESS_REQUIRED_REASON }) }));
    });

    it("asks an order that ships nothing for its country and what tax regions need", () => {
        const de = resolveCheckoutBillingAddress({ billingCountryCode: "de", billingPostalCode: "10115", billingAddress: "ignored" },
            { path: "none", requireFullBillingAddress: false, sellingCountries: selling });
        // Minimal: the street line is not kept.
        expect(de.address).toMatchObject({ countryCode: "DE", postalCode: "10115", line1: null });
        expect(() => resolveCheckoutBillingAddress({ billingCountryCode: "DE" }, { path: "none", requireFullBillingAddress: false, sellingCountries: selling }))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: BILLING_ADDRESS_INVALID_REASON }) }));
        // A full billing address when the merchant requires one.
        expect(() => resolveCheckoutBillingAddress({ billingCountryCode: "DE", billingPostalCode: "10115" }, { path: "none", requireFullBillingAddress: true, sellingCountries: selling }))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: BILLING_ADDRESS_INVALID_REASON }) }));
        // Bangladesh needs only its country; a store selling only there needs nothing sent.
        expect(resolveCheckoutBillingAddress({}, { path: "none", requireFullBillingAddress: false, sellingCountries: ["BD"] }).address)
            .toMatchObject({ countryCode: "BD", line1: null, postalCode: null });
        expect(() => resolveCheckoutBillingAddress({}, { path: "none", requireFullBillingAddress: false, sellingCountries: selling }))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: BILLING_ADDRESS_REQUIRED_REASON }) }));
        expect(() => resolveCheckoutBillingAddress({ billingCountryCode: "FR", billingPostalCode: "75001" }, { path: "none", requireFullBillingAddress: false, sellingCountries: selling }))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: BILLING_COUNTRY_UNAVAILABLE_REASON }) }));
    });

    it("asks a pickup order only when the merchant requires it", () => {
        expect(resolveCheckoutBillingAddress({ billingCountryCode: "BD" }, { path: "pickup", requireFullBillingAddress: false, sellingCountries: selling }))
            .toEqual({ sameAsShipping: false, address: null });
        expect(() => resolveCheckoutBillingAddress({}, { path: "pickup", requireFullBillingAddress: true, sellingCountries: selling }))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: BILLING_ADDRESS_REQUIRED_REASON }) }));
    });
});

describe("billing snapshot columns", () => {
    it("stores same-as-shipping as a literal flag and the contact's name as null", () => {
        const same = orderBillingAddressColumns({ sameAsShipping: true, address: null });
        expect(same.billingSameAsShipping).toBe(true);
        expect(same.billingCountryCode).toBeNull();
        const insert = orderBillingAddressInsertColumns({ ...same, customerName: "x" } as never);
        // Both flags are SQL literals; nothing else is written for a shipped order.
        expect(Object.keys(insert).sort()).toEqual(["billingSameAsShipping", "billingValidationSkipped"]);

        const staff = resolveStaffBillingAddress({ billingCountryCode: "US", billingName: "Ann Lee", billingAdminArea: "CA", billingPostalCode: "94103" }, { ships: false });
        const columns = orderBillingAddressColumns(staff, { name: "Ann Lee" });
        expect(columns).toMatchObject({ billingSameAsShipping: false, billingCountryCode: "US", billingName: null, billingAdminArea: "CA" });
        expect(Object.keys(orderBillingAddressInsertColumns(columns)).sort())
            .toEqual(["billingAdminArea", "billingCountryCode", "billingPostalCode", "billingSameAsShipping", "billingValidationSkipped"]);
        expect(formatOrderBillingAddress(columns)).toBe("CA 94103, US");
        expect(formatOrderBillingAddress({ billingSameAsShipping: true, shippingAddress: "House 1", cityName: "Dhaka", zoneName: "Gulshan" }))
            .toBe("House 1, Gulshan, Dhaka");
        expect(formatOrderBillingAddress({ billingSameAsShipping: false })).toBeNull();
    });

    it("locates a typed billing address for the tax quote", () => {
        expect(billingTaxLocation({ billingCountryCode: "us", billingAdminArea: "California", billingPostalCode: "94103-1234" }))
            .toEqual({ countryCode: "US", adminArea: "CA", postalCode: "94103-1234" });
        expect(billingTaxLocation({ billingCountryCode: "ZZ" })).toBeNull();
    });
});
