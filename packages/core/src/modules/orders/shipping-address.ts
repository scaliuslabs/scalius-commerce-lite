// An order's shipping-address snapshot (MARKETS-DESIGN D7, migration 0113):
// the canonical fields beside Bangladesh's City/Thana/Area adapter, written
// in the order insert by every writer and read flat by every reader
// (`shippingAddress` is the first line, as before).
import { orders } from "@scalius/database/schema";
import { formatAddressInline, type DisplayAddress } from "@scalius/shared/address";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { resolveAddressWithLocation, type AddressInput, type ResolvedAddress } from "../customers";
import type { DeliveryHierarchyLocation } from "@scalius/shared/address";
import type { OrderShippingAddressFields } from "./types";

/** The snapshot's columns for a select (`db.select({ ...orderShippingAddressSelection() })`). */
export function orderShippingAddressSelection(table: typeof orders = orders) {
    return {
        shippingAddress: table.shippingAddress,
        shippingAddressLine2: table.shippingAddressLine2,
        shippingCountryCode: table.shippingCountryCode,
        shippingDependentLocality: table.shippingDependentLocality,
        shippingLocality: table.shippingLocality,
        shippingAdminArea: table.shippingAdminArea,
        shippingPostalCode: table.shippingPostalCode,
        shippingCompany: table.shippingCompany,
        shippingName: table.shippingName,
        shippingPhone: table.shippingPhone,
        shippingValidationSkipped: table.shippingValidationSkipped,
        city: table.city,
        zone: table.zone,
        area: table.area,
        cityName: table.cityName,
        zoneName: table.zoneName,
        areaName: table.areaName,
    } as const;
}

/** No address: pickup, service-only and digital orders. */
export const NO_ORDER_SHIPPING_ADDRESS: OrderShippingAddressFields = {
    shippingAddress: null,
    shippingAddressLine2: null,
    shippingCountryCode: null,
    shippingDependentLocality: null,
    shippingLocality: null,
    shippingAdminArea: null,
    shippingPostalCode: null,
    shippingCompany: null,
    shippingName: null,
    shippingPhone: null,
    shippingValidationSkipped: false,
    city: null,
    zone: null,
    area: null,
    cityName: null,
    zoneName: null,
    areaName: null,
};

/**
 * The order columns of a resolved address (`resolveAddress`), or of none.
 * `contact` is the order's contact: a recipient equal to it is stored as null
 * (null means the contact), so editing the contact keeps them together.
 */
export function orderShippingAddressColumns(
    address: ResolvedAddress | null,
    contact: { name?: string | null; phone?: string | null } = {},
): OrderShippingAddressFields {
    if (!address) return NO_ORDER_SHIPPING_ADDRESS;
    return {
        shippingAddress: address.line1,
        shippingAddressLine2: address.line2,
        shippingCountryCode: address.countryCode,
        shippingDependentLocality: address.dependentLocality,
        shippingLocality: address.locality,
        shippingAdminArea: address.adminArea,
        shippingPostalCode: address.postalCode,
        shippingCompany: address.company,
        shippingName: address.name && address.name !== contact.name?.trim() ? address.name : null,
        shippingPhone: address.phone && address.phone !== contact.phone ? address.phone : null,
        shippingValidationSkipped: address.validationSkipped,
        city: address.city,
        zone: address.zone,
        area: address.area,
        cityName: address.cityName,
        zoneName: address.zoneName,
        areaName: address.areaName,
    };
}

/**
 * The snapshot for an order insert. An absent value is left out rather than
 * bound as NULL: the order insert binds close to D1's 100 parameters, and an
 * omitted column is written as NULL without a parameter.
 */
export function orderShippingAddressInsertColumns(fields: Partial<OrderShippingAddressFields>): Partial<OrderShippingAddressFields> {
    const columns: Partial<OrderShippingAddressFields> = {};
    for (const [key, value] of Object.entries(fields) as Array<[keyof OrderShippingAddressFields, OrderShippingAddressFields[keyof OrderShippingAddressFields]]>) {
        if (value !== null && value !== undefined && value !== false) (columns as Record<string, unknown>)[key] = value;
    }
    // A payload prepared before country-aware addresses carries none: its address is Bangladesh's.
    const country = orderShippingCountry({ shippingAddress: fields.shippingAddress ?? null, shippingCountryCode: fields.shippingCountryCode ?? null });
    if (country) columns.shippingCountryCode = country;
    return columns;
}

/** The country an order ships to: its snapshot's, Bangladesh for an address written before 0113, null when nothing ships. */
export function orderShippingCountry(fields: Pick<OrderShippingAddressFields, "shippingAddress" | "shippingCountryCode">): string | null {
    if (fields.shippingCountryCode) return fields.shippingCountryCode;
    return fields.shippingAddress?.trim() ? DELIVERY_HIERARCHY_COUNTRY : null;
}

/**
 * The snapshot as a buyer sees it, picked field by field from a wider row
 * (never spread: the row carries private columns), without the staff-only
 * skipped-rules flag.
 */
export function buyerOrderShippingAddress(row: OrderShippingAddressFields): Omit<OrderShippingAddressFields, "shippingValidationSkipped"> {
    return {
        shippingAddress: row.shippingAddress,
        shippingAddressLine2: row.shippingAddressLine2,
        shippingCountryCode: row.shippingCountryCode,
        shippingDependentLocality: row.shippingDependentLocality,
        shippingLocality: row.shippingLocality,
        shippingAdminArea: row.shippingAdminArea,
        shippingPostalCode: row.shippingPostalCode,
        shippingCompany: row.shippingCompany,
        shippingName: row.shippingName,
        shippingPhone: row.shippingPhone,
        city: row.city,
        zone: row.zone,
        area: row.area,
        cityName: row.cityName,
        zoneName: row.zoneName,
        areaName: row.areaName,
    };
}

/** The snapshot as a display address (`formatAddressInline`). */
export function orderDisplayAddress(fields: Partial<OrderShippingAddressFields>): DisplayAddress {
    return {
        countryCode: fields.shippingCountryCode ?? null,
        line1: fields.shippingAddress ?? null,
        line2: fields.shippingAddressLine2 ?? null,
        dependentLocality: fields.shippingDependentLocality ?? null,
        locality: fields.shippingLocality ?? null,
        adminArea: fields.shippingAdminArea ?? null,
        postalCode: fields.shippingPostalCode ?? null,
        city: fields.city ?? null,
        zone: fields.zone ?? null,
        area: fields.area ?? null,
        cityName: fields.cityName ?? null,
        zoneName: fields.zoneName ?? null,
        areaName: fields.areaName ?? null,
    };
}

/** One line: a Bangladesh address reads as it always has (line, area, thana, city). */
export function formatOrderShippingAddress(
    fields: Partial<OrderShippingAddressFields>,
    options: { countryName?: (code: string) => string } = {},
): string {
    return formatAddressInline(orderDisplayAddress(fields), options);
}

/** The address fields a staff, agent or checkout order write sends (`shipping*` plus Bangladesh's ids). */
export interface OrderAddressInput {
    shippingCountryCode?: string | null;
    shippingAddress?: string | null;
    shippingAddressLine2?: string | null;
    shippingDependentLocality?: string | null;
    shippingLocality?: string | null;
    shippingAdminArea?: string | null;
    shippingPostalCode?: string | null;
    shippingCompany?: string | null;
    city?: string | null;
    zone?: string | null;
    area?: string | null;
}

/** An order write's address fields as an address input. */
export function orderAddressInput(data: OrderAddressInput): AddressInput {
    return {
        countryCode: data.shippingCountryCode,
        line1: data.shippingAddress,
        line2: data.shippingAddressLine2,
        dependentLocality: data.shippingDependentLocality,
        locality: data.shippingLocality,
        adminArea: data.shippingAdminArea,
        postalCode: data.shippingPostalCode,
        company: data.shippingCompany,
        city: data.city,
        zone: data.zone,
        area: data.area,
    };
}

/**
 * A staff or agent order's shipping address, its Bangladesh location already
 * read and checked (the manual-order quote): the country's rules check the
 * rest; `skipValidation` (staff only) keeps one that breaks them, marked.
 */
export function resolveOrderAddress(
    data: OrderAddressInput,
    location: DeliveryHierarchyLocation | null,
    options: { skipValidation?: boolean } = {},
): ResolvedAddress {
    return resolveAddressWithLocation(
        orderAddressInput(data),
        location ? { location, problems: [] } : { location: null, problems: [{ field: "city", code: "required" }, { field: "zone", code: "required" }] },
        options,
    );
}
