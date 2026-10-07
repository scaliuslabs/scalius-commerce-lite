// The address book and the one address resolution (MARKETS-DESIGN D7, step
// 3a): country rules decide what is required, Bangladesh resolves its
// City/Thana/Area ids to active delivery locations, phones are read in the
// address country, staff may skip the rules (marked), and a customer has at
// most one default address.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    AddressValidationError,
    MAX_CUSTOMER_ADDRESSES,
    createCustomerAddress,
    deleteCustomerAddress,
    listCustomerAddresses,
    resolveAddress,
    setDefaultCustomerAddress,
    updateCustomerAddress,
} from "./addresses";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
        INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active) VALUES
          ('city_dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
          ('zone_mirpur', 'Mirpur', 'BD', 2, 'city_dhaka', '{}', '{}', 1),
          ('area_10', 'Section 10', 'BD', 3, 'zone_mirpur', '{}', '{}', 1),
          ('city_ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1),
          ('zone_old', 'Old Thana', 'BD', 2, 'city_dhaka', '{}', '{}', 0);
        INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111111');
    `);
});
afterEach(() => sqlite.close());

const problems = async (promise: Promise<unknown>) => {
    try {
        await promise;
        return null;
    } catch (error) {
        if (error instanceof AddressValidationError) return error.issues;
        throw error;
    }
};

describe("resolveAddress", () => {
    it("fills Bangladesh's locality and thana from the picked locations, never an admin area", async () => {
        expect(await resolveAddress(db, {
            line1: "House 1, Road 2", city: "city_dhaka", zone: "zone_mirpur", area: "area_10", adminArea: "Dhaka Division",
        })).toMatchObject({
            countryCode: "BD",
            line1: "House 1, Road 2",
            locality: "Dhaka",
            dependentLocality: "Mirpur",
            adminArea: null,
            city: "city_dhaka",
            zone: "zone_mirpur",
            area: "area_10",
            cityName: "Dhaka",
            zoneName: "Mirpur",
            areaName: "Section 10",
            validationSkipped: false,
        });
    });

    it("refuses a Bangladesh address whose City/Thana is missing, inactive or crossed", async () => {
        expect(await problems(resolveAddress(db, { countryCode: "BD", line1: "House 1" })))
            .toEqual([{ field: "city", code: "required" }, { field: "zone", code: "required" }]);
        expect(await problems(resolveAddress(db, { countryCode: "BD", line1: "House 1", city: "city_dhaka", zone: "zone_old" })))
            .toEqual([{ field: "zone", code: "unavailable" }]);
        expect(await problems(resolveAddress(db, { countryCode: "BD", line1: "House 1", city: "city_ctg", zone: "zone_mirpur" })))
            .toEqual([{ field: "zone", code: "unavailable" }]);
    });

    it("checks another country by its rules and drops Bangladesh's ids there", async () => {
        expect(await problems(resolveAddress(db, { countryCode: "US", line1: "1 Infinite Loop", locality: "Cupertino" })))
            .toEqual([{ field: "adminArea", code: "required" }, { field: "postalCode", code: "required" }]);
        expect(await resolveAddress(db, {
            countryCode: "us", line1: "1 Infinite Loop", locality: "Cupertino", adminArea: "California", postalCode: "95014",
            city: "city_dhaka", zone: "zone_mirpur", phone: "(415) 555-2671",
        })).toMatchObject({
            countryCode: "US", adminArea: "CA", postalCode: "95014", city: null, zone: null, cityName: null,
            phone: "+14155552671", phoneRaw: "(415) 555-2671",
        });
        expect(await problems(resolveAddress(db, { countryCode: "ZZ", line1: "x" })))
            .toEqual([{ field: "countryCode", code: "unknown_country" }]);
    });

    it("keeps a staff address that breaks its rules, marked, with what was typed", async () => {
        const kept = await resolveAddress(db, { countryCode: "GB", line1: "1 High Street", phone: "not a phone" }, { skipValidation: true });
        expect(kept).toMatchObject({ countryCode: "GB", line1: "1 High Street", postalCode: null, phone: null, phoneRaw: "not a phone", validationSkipped: true });
        // Never a value too long for its field.
        expect(await problems(resolveAddress(db, { countryCode: "GB", line1: "x".repeat(501) }, { skipValidation: true })))
            .toEqual([{ field: "line1", code: "too_long" }]);
    });
});

describe("the address book", () => {
    const bd = { countryCode: "BD", line1: "House 1, Road 2", city: "city_dhaka", zone: "zone_mirpur" };
    const us = { countryCode: "US", line1: "1 Infinite Loop", locality: "Cupertino", adminArea: "CA", postalCode: "95014" };

    it("makes the first address the default and keeps one default per customer", async () => {
        const first = await createCustomerAddress(db, "cust_1", bd);
        const second = await createCustomerAddress(db, "cust_1", us);
        expect(first.isDefault).toBe(true);
        expect(second.isDefault).toBe(false);

        await setDefaultCustomerAddress(db, "cust_1", second.id);
        expect((await listCustomerAddresses(db, "cust_1")).map((address) => [address.id, address.isDefault]))
            .toEqual([[second.id, true], [first.id, false]]);

        const third = await createCustomerAddress(db, "cust_1", { ...us, line1: "2 Infinite Loop", isDefault: true });
        expect((await listCustomerAddresses(db, "cust_1")).filter((address) => address.isDefault).map((address) => address.id)).toEqual([third.id]);

        await updateCustomerAddress(db, "cust_1", first.id, { ...bd, line1: "House 9", isDefault: true });
        const book = await listCustomerAddresses(db, "cust_1");
        expect(book.filter((address) => address.isDefault).map((address) => address.id)).toEqual([first.id]);
        expect(book[0]).toMatchObject({ id: first.id, line1: "House 9", isDefault: true });
    });

    it("promotes the most recently updated address when the default goes", async () => {
        const first = await createCustomerAddress(db, "cust_1", bd);
        const second = await createCustomerAddress(db, "cust_1", us);
        sqlite.prepare("UPDATE customer_addresses SET updated_at = updated_at + 10 WHERE id = ?").run(second.id);
        await deleteCustomerAddress(db, "cust_1", first.id);
        expect(await listCustomerAddresses(db, "cust_1")).toEqual([expect.objectContaining({ id: second.id, isDefault: true })]);
        await deleteCustomerAddress(db, "cust_1", second.id);
        expect(await listCustomerAddresses(db, "cust_1")).toEqual([]);
        await expect(deleteCustomerAddress(db, "cust_1", second.id)).rejects.toThrow("Address not found");
    });

    it("refuses another customer's address and a full book", async () => {
        sqlite.exec("INSERT INTO customers (id, name, phone) VALUES ('cust_2', 'Sumi', '+8801722222222')");
        const theirs = await createCustomerAddress(db, "cust_2", bd);
        await expect(setDefaultCustomerAddress(db, "cust_1", theirs.id)).rejects.toThrow("Address not found");
        await expect(updateCustomerAddress(db, "cust_1", theirs.id, bd)).rejects.toThrow("Address not found");
        for (let index = 0; index < MAX_CUSTOMER_ADDRESSES; index += 1) {
            sqlite.prepare("INSERT INTO customer_addresses (id, customer_id, country_code, line1) VALUES (?, 'cust_1', 'IN', 'x')").run(`caddr_fill_${index}`);
        }
        await expect(createCustomerAddress(db, "cust_1", bd)).rejects.toThrow(`at most ${MAX_CUSTOMER_ADDRESSES} addresses`);
        await expect(createCustomerAddress(db, "cust_missing", bd)).rejects.toThrow("Customer not found");
    });
});
