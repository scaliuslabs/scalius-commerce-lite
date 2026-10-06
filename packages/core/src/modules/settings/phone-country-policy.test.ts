import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { createCustomer, updateCustomer } from "../customers/customers.service";
import { acceptedCustomerCountries, readAcceptedCustomerCountries, validateCustomerPhoneCountry } from "./phone-country-policy";
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

describe("phone countries follow the markets", () => {
    const sellTo = (sqlite: import("node:sqlite").DatabaseSync, status: "active" | "draft", ...countries: string[]) => {
        sqlite.exec(`INSERT INTO markets (id, handle, name, status) VALUES ('mkt_india', 'india', 'India', '${status}')`);
        for (const country of countries) {
            sqlite.prepare("INSERT INTO market_countries (country_code, market_id) VALUES (?, 'mkt_india')").run(country);
        }
    };

    it("accepts a number from every country an active market sells to, with the merchant policy unchanged", async () => {
        const { sqlite, db } = await setup(["BD"], "include");
        sellTo(sqlite, "active", "IN");

        await expect(validateCustomerPhoneCountry(db, "+919876543210")).resolves.toBe("+919876543210");
        await expect(validateCustomerPhoneCountry(db, "+8801712345678")).resolves.toBe("+8801712345678");
        // No market sells to the United States, and the merchant list does not name it.
        await expect(validateCustomerPhoneCountry(db, "+14155552671")).rejects.toThrow("Phone numbers from US are not accepted");
        expect(await readAcceptedCustomerCountries(db)).toEqual({ allowedCountries: ["BD", "IN"], allowedCountriesMode: "include" });
    });

    it("ignores a draft market and takes a market country out of an exclude list", async () => {
        const draft = await setup(["BD"], "include");
        sellTo(draft.sqlite, "draft", "IN");
        await expect(validateCustomerPhoneCountry(draft.db, "+919876543210")).rejects.toThrow("Phone numbers from IN are not accepted");

        const exclude = await setup(["IN", "US"], "exclude");
        sellTo(exclude.sqlite, "active", "IN");
        await expect(validateCustomerPhoneCountry(exclude.db, "+919876543210")).resolves.toBe("+919876543210");
        await expect(validateCustomerPhoneCountry(exclude.db, "+14155552671")).rejects.toThrow("Phone numbers from US are not accepted");
    });

    it("guards admin customer creation with the same list", async () => {
        const { sqlite, db } = await setup(["BD"], "include");
        sellTo(sqlite, "active", "IN");

        await createCustomer(db, { ...customer, phone: "+919876543210" });
        await expect(createCustomer(db, { ...customer, email: "us@example.com", phone: "+14155552671" }))
            .rejects.toThrow("Phone numbers from US are not accepted");
        expect(sqlite.prepare("SELECT phone FROM customers").all()).toEqual([{ phone: "+919876543210" }]);
    });

    it("is a pure union for the checkout authority and config", () => {
        expect(acceptedCustomerCountries({ allowedCountries: ["BD"], allowedCountriesMode: "include" }, ["BD", "IN"]))
            .toEqual({ allowedCountries: ["BD", "IN"], allowedCountriesMode: "include" });
        expect(acceptedCustomerCountries({ allowedCountries: [], allowedCountriesMode: "include" }, ["BD", "IN"]))
            .toEqual({ allowedCountries: [], allowedCountriesMode: "include" });
        expect(acceptedCustomerCountries({ allowedCountries: ["BD"], allowedCountriesMode: "include" }, undefined))
            .toEqual({ allowedCountries: ["BD"], allowedCountriesMode: "include" });
    });
});
