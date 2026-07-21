import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateCustomerPhoneCountry } from "./phone-country-policy";

const settingsMocks = vi.hoisted(() => ({
    getAllowedCountries: vi.fn(),
}));

vi.mock("./site-settings.service", () => ({
    getAllowedCountries: settingsMocks.getAllowedCountries,
}));

describe("trusted customer phone-country policy", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("accepts an included country and normalizes the number", async () => {
        settingsMocks.getAllowedCountries.mockResolvedValue({
            allowedCountries: ["BD", "AE", "US"],
            allowedCountriesMode: "include",
        });

        await expect(validateCustomerPhoneCountry({} as never, "+880 1712-345678"))
            .resolves.toBe("+8801712345678");
    });

    it("rejects countries outside include policy and inside exclude policy", async () => {
        settingsMocks.getAllowedCountries.mockResolvedValueOnce({
            allowedCountries: ["BD"],
            allowedCountriesMode: "include",
        });
        await expect(validateCustomerPhoneCountry({} as never, "+919876543210"))
            .rejects.toThrow("Phone numbers from IN are not accepted");

        settingsMocks.getAllowedCountries.mockResolvedValueOnce({
            allowedCountries: ["IN"],
            allowedCountriesMode: "exclude",
        });
        await expect(validateCustomerPhoneCountry({} as never, "+919876543210"))
            .rejects.toThrow("Phone numbers from IN are not accepted");
    });

    it("guards admin customer and manual-order phone creation and changes", () => {
        const customersSource = readFileSync(
            fileURLToPath(new URL("../customers/customers.service.ts", import.meta.url)),
            "utf8",
        );
        const ordersSource = readFileSync(
            fileURLToPath(new URL("../orders/orders.admin.ts", import.meta.url)),
            "utf8",
        );
        const customerCreate = customersSource.slice(
            customersSource.indexOf("export async function createCustomer"),
            customersSource.indexOf("export async function getCustomerById"),
        );
        const customerUpdate = customersSource.slice(
            customersSource.indexOf("export async function updateCustomer"),
            customersSource.indexOf("export async function deleteCustomer"),
        );
        const orderCreate = ordersSource.slice(
            ordersSource.indexOf("export async function createOrder(\n"),
            ordersSource.indexOf("interface UpdateOrderItem"),
        );
        const orderUpdate = ordersSource.slice(
            ordersSource.indexOf("export async function updateOrder("),
            ordersSource.indexOf("export async function restoreOrder"),
        );

        expect(customerCreate).toContain("validateCustomerPhoneCountry(db, data.phone)");
        expect(customerUpdate).toContain("validateCustomerPhoneCountry(db, data.phone)");
        expect(orderCreate).toContain("validateCustomerPhoneCountry(db, data.customerPhone)");
        expect(orderUpdate).toContain("validateCustomerPhoneCountry(db, data.customerPhone)");
        expect(orderCreate.indexOf("resolveAdminOrderCreateAttempt")).toBeLessThan(
            orderCreate.indexOf("validateCustomerPhoneCountry"),
        );
        expect(orderCreate.indexOf("validateCustomerPhoneCountry")).toBeLessThan(
            orderCreate.indexOf("claimAdminOrderCreateAttempt"),
        );
    });
});
