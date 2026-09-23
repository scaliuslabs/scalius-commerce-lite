import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { createCustomer, updateCustomer } from "../customers/customers.service";
import { validateCustomerPhoneCountry } from "./phone-country-policy";
import { saveAllowedCountries } from "./site-settings.service";

async function setup(countries: string[], mode: "include" | "exclude") {
    const harness = createSqliteD1Database();
    await saveAllowedCountries(harness.db, countries, mode);
    return harness;
}

const customer = { name: "Buyer One", email: null, address: null, city: null, zone: null, area: null };

describe("trusted customer phone-country policy", () => {
    it("accepts an included country and normalizes the number", async () => {
        const { db } = await setup(["BD", "AE", "US"], "include");

        await expect(validateCustomerPhoneCountry(db, "+880 1712-345678"))
            .resolves.toBe("+8801712345678");
    });

    it("rejects countries outside include policy and inside exclude policy", async () => {
        const include = await setup(["BD"], "include");
        await expect(validateCustomerPhoneCountry(include.db, "+919876543210"))
            .rejects.toThrow("Phone numbers from IN are not accepted");

        const exclude = await setup(["IN"], "exclude");
        await expect(validateCustomerPhoneCountry(exclude.db, "+919876543210"))
            .rejects.toThrow("Phone numbers from IN are not accepted");
    });

    it("guards admin customer phone creation and changes", async () => {
        const { sqlite, db } = await setup(["BD"], "include");

        await expect(createCustomer(db, { ...customer, phone: "+919876543210" }))
            .rejects.toThrow("Phone numbers from IN are not accepted");
        const { id } = await createCustomer(db, { ...customer, phone: "+8801712345678" });
        await expect(updateCustomer(db, id, { phone: "+919876543210" }))
            .rejects.toThrow("Phone numbers from IN are not accepted");

        expect(sqlite.prepare("SELECT phone FROM customers").all()).toEqual([{ phone: "+8801712345678" }]);
    });
});
