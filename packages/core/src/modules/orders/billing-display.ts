// An order's billing address for display (browser safe: the dashboard, the
// CSV export, invoices and messages). The shipping address when it bills,
// else the billing snapshot (migration 0119), else none.
import { formatAddressInline, type DisplayAddress } from "@scalius/shared/address";
import type { OrderBillingAddressFields, OrderShippingAddressFields } from "./types";

/**
 * The billing address to show, or null when the order has none: the
 * shipping address when it bills, else the billing snapshot.
 */
export function orderBillingDisplayAddress(
    row: Partial<OrderBillingAddressFields> & Partial<OrderShippingAddressFields>,
): DisplayAddress | null {
    if (row.billingSameAsShipping === true) {
        if (!row.shippingAddress?.trim() && !row.shippingCountryCode) return null;
        return {
            countryCode: row.shippingCountryCode ?? null,
            line1: row.shippingAddress ?? null,
            line2: row.shippingAddressLine2 ?? null,
            dependentLocality: row.shippingDependentLocality ?? null,
            locality: row.shippingLocality ?? null,
            adminArea: row.shippingAdminArea ?? null,
            postalCode: row.shippingPostalCode ?? null,
            city: row.city ?? null,
            zone: row.zone ?? null,
            area: row.area ?? null,
            cityName: row.cityName ?? null,
            zoneName: row.zoneName ?? null,
            areaName: row.areaName ?? null,
        };
    }
    if (!row.billingCountryCode) return null;
    return {
        countryCode: row.billingCountryCode,
        line1: row.billingAddress ?? null,
        line2: row.billingAddressLine2 ?? null,
        dependentLocality: row.billingDependentLocality ?? null,
        locality: row.billingLocality ?? null,
        adminArea: row.billingAdminArea ?? null,
        postalCode: row.billingPostalCode ?? null,
    };
}

/** One line, or null without a billing address. */
export function formatOrderBillingAddress(
    row: Partial<OrderBillingAddressFields> & Partial<OrderShippingAddressFields>,
    options: { countryName?: (code: string) => string } = {},
): string | null {
    const address = orderBillingDisplayAddress(row);
    return address ? formatAddressInline(address, options) : null;
}
