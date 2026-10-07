// Addresses (MARKETS-DESIGN D7): one resolution of a postal address for every
// writer (checkout, staff orders, the customer address book, agents), and the
// address book itself (Shopify's customer addresses).
//
// - A country's libaddressinput rules (`@scalius/shared/address-metadata`)
//   decide the allowed and required fields, the postal code pattern and the
//   admin area list. An unknown country is refused.
// - Bangladesh uses its City/Thana/Area adapter: the delivery-location ids
//   must name active locations in that hierarchy, and their names fill the
//   locality and dependent locality. No admin area is ever invented.
// - The recipient's phone is read in the address country (E.164); what was
//   typed is kept beside it.
// - Staff (never buyers) may save an address that breaks its rules
//   (`skipValidation`): it is stored as typed and marked validation_skipped.
import type { Database } from "@scalius/database/client";
import { CUSTOMER_ADDRESS_ID_PREFIX, customerAddresses, customers, placeAddressFieldSql, places } from "@scalius/database/schema";
import {
    deliveryHierarchyCanonicalFields,
    normalizeAddressText,
    usesDeliveryHierarchy,
    validatePostalAddress,
    type AddressField,
    type AddressIssueCode,
    type DeliveryHierarchyLocation,
    type PostalAddress,
    type PostalAddressInput,
} from "@scalius/shared/address";
import { addressRulesFor } from "@scalius/shared/address-metadata";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { DELIVERY_HIERARCHY_COUNTRY, normalizeMarketCountry } from "@scalius/shared/markets";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

/** `details.reason` of every refused address. */
export const ADDRESS_INVALID_REASON = "address_invalid";
/** Shopify-like ceiling that keeps one customer's book a bounded read. */
export const MAX_CUSTOMER_ADDRESSES = 50;

/** What a form, the dashboard, an agent or checkout sends. */
export interface AddressInput extends PostalAddressInput {
    /** The recipient's phone, read in the address country. */
    phone?: string | null;
    /** Bangladesh adapter: delivery-location ids. */
    city?: string | null;
    zone?: string | null;
    area?: string | null;
}

/** A resolved address: canonical fields, the Bangladesh adapter and the phone. */
export interface ResolvedAddress extends PostalAddress, DeliveryHierarchyLocation {
    /** E.164, or null when none was given (or it could not be read and validation was skipped). */
    phone: string | null;
    /** What was typed for the phone. */
    phoneRaw: string | null;
}

export type AddressProblemField = AddressField | "countryCode" | "phone" | "city" | "zone" | "area";

export interface AddressProblem {
    field: AddressProblemField;
    code: AddressIssueCode | "unavailable";
}

const FIELD_NAMES: Record<AddressProblemField, string> = {
    countryCode: "country",
    name: "name",
    company: "company",
    line1: "address",
    line2: "second address line",
    dependentLocality: "neighbourhood",
    locality: "city",
    adminArea: "region",
    postalCode: "postal code",
    phone: "phone number",
    city: "city",
    zone: "thana",
    area: "area",
};

/** One sentence for the first problem; forms map `details.issues` to their fields. */
export function addressProblemMessage(problem: AddressProblem): string {
    const name = FIELD_NAMES[problem.field];
    switch (problem.code) {
        case "unknown_country":
            return "We can't take addresses in that country.";
        case "required":
            return `Enter the ${name}.`;
        case "too_long":
            return `The ${name} is too long.`;
        case "unavailable":
            return `The selected ${name} is no longer available. Choose it again.`;
        default:
            return `Check the ${name}.`;
    }
}

export class AddressValidationError extends ValidationError {
    readonly issues: AddressProblem[];
    constructor(issues: AddressProblem[]) {
        super(addressProblemMessage(issues[0]!), { reason: ADDRESS_INVALID_REASON, issues });
        this.issues = issues;
    }
}

// ---------------------------------------------------------------------------
// The Bangladesh adapter
// ---------------------------------------------------------------------------

export interface AddressLocationRow {
    id: string;
    name: string;
    type: string;
    parentId: string | null;
}

/** Active Bangladesh places by id, for the adapter (its field from the place's level). */
export function selectAddressLocationRows(db: Database, ids: readonly string[]) {
    return db
        .select({
            id: places.id,
            name: places.name,
            type: placeAddressFieldSql,
            parentId: places.parentId,
        })
        .from(places)
        .where(and(
            inArray(places.id, ids.length > 0 ? [...ids] : ["__none__"]),
            eq(places.countryCode, DELIVERY_HIERARCHY_COUNTRY),
            eq(places.isActive, true),
            isNull(places.deletedAt),
        ));
}

const trimmedId = (value: string | null | undefined) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The adapter ids an input names (for the location read). */
export function addressLocationIds(input: Pick<AddressInput, "city" | "zone" | "area">): string[] {
    return [input.city, input.zone, input.area].map(trimmedId).filter((id): id is string => id !== null);
}

/**
 * City → Thana → Area from active location rows, or the problems: a city
 * without a parent, a thana under it and an optional area under the thana.
 */
export function resolveDeliveryHierarchy(
    input: Pick<AddressInput, "city" | "zone" | "area">,
    rows: readonly AddressLocationRow[],
): { location: DeliveryHierarchyLocation | null; problems: AddressProblem[] } {
    const cityId = trimmedId(input.city);
    const zoneId = trimmedId(input.zone);
    const areaId = trimmedId(input.area);
    const problems: AddressProblem[] = [];
    if (!cityId) problems.push({ field: "city", code: "required" });
    if (!zoneId) problems.push({ field: "zone", code: "required" });
    if (problems.length > 0) return { location: null, problems };
    const byId = new Map(rows.map((row) => [row.id, row]));
    const city = byId.get(cityId!);
    if (!city || city.type !== "city" || city.parentId !== null) {
        return { location: null, problems: [{ field: "city", code: "unavailable" }] };
    }
    const zone = byId.get(zoneId!);
    if (!zone || zone.type !== "zone" || zone.parentId !== city.id) {
        return { location: null, problems: [{ field: "zone", code: "unavailable" }] };
    }
    const area = areaId ? byId.get(areaId) : null;
    if (areaId && (!area || area.type !== "area" || area.parentId !== zone.id)) {
        return { location: null, problems: [{ field: "area", code: "unavailable" }] };
    }
    return {
        location: {
            city: city.id,
            zone: zone.id,
            area: area?.id ?? null,
            cityName: city.name,
            zoneName: zone.name,
            areaName: area?.name ?? null,
        },
        problems: [],
    };
}

const NO_LOCATION: DeliveryHierarchyLocation = { city: null, zone: null, area: null, cityName: null, zoneName: null, areaName: null };

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveAddressOptions {
    /** Staff only: keep an address that breaks its rules, marked validation_skipped. */
    skipValidation?: boolean;
}

/**
 * Resolves an address from its input and the delivery-location rows its
 * adapter ids name (none outside Bangladesh). A missing country is
 * Bangladesh: the forms that send none are its City/Thana/Area forms.
 */
export function resolveAddressFromRows(
    input: AddressInput,
    locationRows: readonly AddressLocationRow[],
    options: ResolveAddressOptions = {},
): ResolvedAddress {
    const countryCode = addressCountryOf(input);
    const hierarchy = countryCode && usesDeliveryHierarchy(countryCode)
        ? resolveDeliveryHierarchy(input, locationRows)
        : { location: null, problems: [] };
    return resolveAddressWithLocation(input, hierarchy, options);
}

/** The input's country: a valid ISO code, Bangladesh when none was sent, null for an invalid one. */
function addressCountryOf(input: Pick<AddressInput, "countryCode">): string | null {
    if (typeof input.countryCode === "string" && input.countryCode.trim()) return normalizeMarketCountry(input.countryCode);
    return DELIVERY_HIERARCHY_COUNTRY;
}

/**
 * Resolves an address whose Bangladesh delivery location is already known
 * (checkout's delivery preflight read and checked it): the location's names
 * fill the locality and dependent locality.
 */
export function resolveAddressWithLocation(
    input: AddressInput,
    hierarchy: { location: DeliveryHierarchyLocation | null; problems: AddressProblem[] },
    options: ResolveAddressOptions = {},
): ResolvedAddress {
    const countryCode = addressCountryOf(input);
    const rules = addressRulesFor(countryCode);
    if (!countryCode || !rules) throw new AddressValidationError([{ field: "countryCode", code: "unknown_country" }]);
    const skip = options.skipValidation === true;
    const problems: AddressProblem[] = [];

    let location = NO_LOCATION;
    let canonicalInput: PostalAddressInput = { ...input, countryCode };
    if (usesDeliveryHierarchy(countryCode)) {
        if (hierarchy.location) {
            location = hierarchy.location;
            // The adapter fills the locality and dependent locality; it never invents an admin area.
            canonicalInput = { ...canonicalInput, ...deliveryHierarchyCanonicalFields(location), adminArea: null };
        } else {
            problems.push(...hierarchy.problems);
            canonicalInput = { ...canonicalInput, adminArea: null };
        }
    }

    const validated = validatePostalAddress(canonicalInput, rules);
    // In Bangladesh the City is the locality: a missing City is already the problem.
    const adapterFailed = usesDeliveryHierarchy(countryCode) && !hierarchy.location;
    problems.push(...validated.issues.filter((issue) => !(adapterFailed && issue.field === "locality" && issue.code === "required")));

    const phoneRaw = normalizeAddressText(input.phone);
    let phone: string | null = null;
    if (phoneRaw) {
        try {
            phone = validateAndFormatPhone(phoneRaw, undefined, { defaultCountry: countryCode });
        } catch {
            problems.push({ field: "phone", code: "invalid" });
        }
    }

    const tooLong = problems.filter((problem) => problem.code === "too_long");
    if (tooLong.length > 0) throw new AddressValidationError(tooLong);
    if (problems.length > 0 && !skip) throw new AddressValidationError(problems);

    // Kept as typed when skipped; the adapter ids are stored only when they name a real hierarchy.
    const skipped = problems.length > 0;
    const address: PostalAddress = skipped
        ? {
            ...validatePostalAddress(canonicalInput, rules, { skipValidation: true }).address,
            validationSkipped: true,
        }
        : validated.address;
    // Bangladesh's format has no dependent locality line, but the adapter keeps
    // the thana there (and the city as locality) for every reader.
    const adapted = location === NO_LOCATION ? address : { ...address, ...deliveryHierarchyCanonicalFields(location) };
    return { ...adapted, ...location, phone, phoneRaw };
}

/** `resolveAddressFromRows` reading the adapter's locations (one statement, Bangladesh only). */
export async function resolveAddress(db: Database, input: AddressInput, options: ResolveAddressOptions = {}): Promise<ResolvedAddress> {
    const country = normalizeMarketCountry(input.countryCode) ?? DELIVERY_HIERARCHY_COUNTRY;
    const ids = usesDeliveryHierarchy(country) ? addressLocationIds(input) : [];
    const rows = ids.length > 0 ? await selectAddressLocationRows(db, ids) : [];
    return resolveAddressFromRows(input, rows, options);
}

// ---------------------------------------------------------------------------
// The address book
// ---------------------------------------------------------------------------

export interface CustomerAddress extends ResolvedAddress {
    id: string;
    customerId: string;
    isDefault: boolean;
    /** The default billing address (migration 0119); none means the default address bills too. */
    isDefaultBilling: boolean;
    createdAt: number;
    updatedAt: number;
}

type CustomerAddressRow = typeof customerAddresses.$inferSelect;

const seconds = (value: Date | number | null | undefined): number =>
    value instanceof Date ? Math.floor(value.getTime() / 1000) : Number(value ?? 0);

export function customerAddressFromRow(row: CustomerAddressRow): CustomerAddress {
    return {
        id: row.id,
        customerId: row.customerId,
        isDefault: Boolean(row.isDefault),
        isDefaultBilling: Boolean(row.isDefaultBilling),
        countryCode: row.countryCode,
        name: row.name,
        company: row.company,
        line1: row.line1,
        line2: row.line2,
        dependentLocality: row.dependentLocality,
        locality: row.locality,
        adminArea: row.adminArea,
        postalCode: row.postalCode,
        phone: row.phoneE164,
        phoneRaw: row.phoneRaw,
        city: row.city,
        zone: row.zone,
        area: row.area,
        cityName: row.cityName,
        zoneName: row.zoneName,
        areaName: row.areaName,
        validationSkipped: Boolean(row.validationSkipped),
        createdAt: seconds(row.createdAt),
        updatedAt: seconds(row.updatedAt),
    };
}

/** The columns an address is stored in. */
export function customerAddressColumns(address: ResolvedAddress) {
    return {
        countryCode: address.countryCode,
        name: address.name,
        company: address.company,
        line1: address.line1,
        line2: address.line2,
        dependentLocality: address.dependentLocality,
        locality: address.locality,
        adminArea: address.adminArea,
        postalCode: address.postalCode,
        phoneE164: address.phone,
        phoneRaw: address.phoneRaw,
        city: address.city,
        zone: address.zone,
        area: address.area,
        cityName: address.cityName,
        zoneName: address.zoneName,
        areaName: address.areaName,
        validationSkipped: address.validationSkipped,
    };
}

/** A customer's addresses, the default first, then the newest. */
export async function listCustomerAddresses(db: Database, customerId: string): Promise<CustomerAddress[]> {
    const rows = await db.select().from(customerAddresses)
        .where(eq(customerAddresses.customerId, customerId))
        .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.updatedAt), asc(customerAddresses.id))
        .limit(MAX_CUSTOMER_ADDRESSES);
    return rows.map(customerAddressFromRow);
}

/** The live customer and how many addresses it has (one statement). */
async function requireCustomer(db: Database, customerId: string): Promise<{ addressCount: number }> {
    const customer = await db.select({
        id: customers.id,
        // Qualified: drizzle leaves a one-table select's columns bare, and a bare name binds inside the subquery first.
        addressCount: sql<number>`(SELECT count(*) FROM customer_addresses AS counted WHERE counted.customer_id = "customers"."id")`,
    }).from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .get();
    if (!customer) throw new NotFoundError("Customer not found");
    return { addressCount: Number(customer.addressCount ?? 0) };
}

/** Clears the customer's other default, then makes `addressId` the default (one batch). */
function defaultWrites(db: Database, customerId: string, addressId: string) {
    return [
        db.update(customerAddresses)
            .set({ isDefault: false, updatedAt: sql`unixepoch()` })
            .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.isDefault, true), ne(customerAddresses.id, addressId))),
        db.update(customerAddresses)
            .set({ isDefault: true, updatedAt: sql`unixepoch()` })
            .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId))),
    ] as const;
}

/** Clears the customer's other default billing address, then makes `addressId` it (one batch). */
function defaultBillingWrites(db: Database, customerId: string, addressId: string) {
    return [
        db.update(customerAddresses)
            .set({ isDefaultBilling: false, updatedAt: sql`unixepoch()` })
            .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.isDefaultBilling, true), ne(customerAddresses.id, addressId))),
        db.update(customerAddresses)
            .set({ isDefaultBilling: true, updatedAt: sql`unixepoch()` })
            .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId))),
    ] as const;
}

/**
 * Adds an address. The customer's first address is the default; `isDefault`
 * makes a later one the default and `isDefaultBilling` the default billing
 * address. At most MAX_CUSTOMER_ADDRESSES.
 */
export async function createCustomerAddress(
    db: Database,
    customerId: string,
    input: AddressInput & { isDefault?: boolean; isDefaultBilling?: boolean },
    options: ResolveAddressOptions = {},
): Promise<CustomerAddress> {
    const { addressCount: existing } = await requireCustomer(db, customerId);
    if (existing >= MAX_CUSTOMER_ADDRESSES) {
        throw new ConflictError(`A customer can have at most ${MAX_CUSTOMER_ADDRESSES} addresses.`);
    }
    const address = await resolveAddress(db, input, options);
    const id = `${CUSTOMER_ADDRESS_ID_PREFIX}${nanoid()}`;
    const makeDefault = existing === 0 || input.isDefault === true;
    const insert = db.insert(customerAddresses).values({
        id,
        customerId,
        isDefault: false,
        ...customerAddressColumns(address),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    });
    const writes = [
        insert,
        ...(makeDefault ? defaultWrites(db, customerId, id) : []),
        ...(input.isDefaultBilling === true ? defaultBillingWrites(db, customerId, id) : []),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch tuple typing.
    await db.batch(writes as any);
    const row = await db.select().from(customerAddresses).where(eq(customerAddresses.id, id)).get();
    return customerAddressFromRow(row!);
}

/**
 * Replaces an address's fields (`isDefault: true` also makes it the default,
 * `isDefaultBilling` true or false makes it the default billing address or
 * clears that).
 */
export async function updateCustomerAddress(
    db: Database,
    customerId: string,
    addressId: string,
    input: AddressInput & { isDefault?: boolean; isDefaultBilling?: boolean },
    options: ResolveAddressOptions = {},
): Promise<CustomerAddress> {
    const current = await db.select({ id: customerAddresses.id }).from(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
        .get();
    if (!current) throw new NotFoundError("Address not found");
    const address = await resolveAddress(db, input, options);
    const update = db.update(customerAddresses)
        .set({ ...customerAddressColumns(address), updatedAt: sql`unixepoch()` })
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)));
    const writes = [
        update,
        ...(input.isDefault === true ? defaultWrites(db, customerId, addressId) : []),
        ...(input.isDefaultBilling === true ? defaultBillingWrites(db, customerId, addressId) : []),
        ...(input.isDefaultBilling === false
            ? [db.update(customerAddresses)
                .set({ isDefaultBilling: false, updatedAt: sql`unixepoch()` })
                .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId), eq(customerAddresses.isDefaultBilling, true)))]
            : []),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch tuple typing.
    await db.batch(writes as any);
    const row = await db.select().from(customerAddresses).where(eq(customerAddresses.id, addressId)).get();
    return customerAddressFromRow(row!);
}

/** Makes an address the customer's default. */
export async function setDefaultCustomerAddress(db: Database, customerId: string, addressId: string): Promise<CustomerAddress> {
    const current = await db.select({ id: customerAddresses.id }).from(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
        .get();
    if (!current) throw new NotFoundError("Address not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch tuple typing.
    await db.batch(defaultWrites(db, customerId, addressId) as any);
    const row = await db.select().from(customerAddresses).where(eq(customerAddresses.id, addressId)).get();
    return customerAddressFromRow(row!);
}

/** Makes an address the customer's default billing address. */
export async function setDefaultBillingCustomerAddress(db: Database, customerId: string, addressId: string): Promise<CustomerAddress> {
    const current = await db.select({ id: customerAddresses.id }).from(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
        .get();
    if (!current) throw new NotFoundError("Address not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch tuple typing.
    await db.batch(defaultBillingWrites(db, customerId, addressId) as any);
    const row = await db.select().from(customerAddresses).where(eq(customerAddresses.id, addressId)).get();
    return customerAddressFromRow(row!);
}

/**
 * Deletes an address; when it was the default, the most recently updated
 * other address becomes the default. A deleted default billing address
 * leaves none (the default address then bills, Shopify's rule).
 */
export async function deleteCustomerAddress(db: Database, customerId: string, addressId: string): Promise<void> {
    const deleted = await db.delete(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)))
        .returning({ id: customerAddresses.id, isDefault: customerAddresses.isDefault });
    if (deleted.length === 0) throw new NotFoundError("Address not found");
    if (!deleted[0]!.isDefault) return;
    await db.update(customerAddresses)
        .set({ isDefault: true, updatedAt: sql`unixepoch()` })
        .where(and(
            eq(customerAddresses.customerId, customerId),
            sql`${customerAddresses.id} = (SELECT next_default.id FROM customer_addresses AS next_default
                WHERE next_default.customer_id = ${customerId}
                ORDER BY next_default.updated_at DESC, next_default.id ASC LIMIT 1)`,
            sql`NOT EXISTS (SELECT 1 FROM customer_addresses AS current_default
                WHERE current_default.customer_id = ${customerId} AND current_default.is_default = 1)`,
        ));
}
