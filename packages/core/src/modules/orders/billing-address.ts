// An order's billing-address snapshot (migration 0119, Shopify's rule): the
// canonical fields with a `billing` prefix, written in the order insert and
// read flat. `billingSameAsShipping` means the shipping address bills; the
// billing columns then stay null. A billing address has no Bangladesh
// City/Thana/Area adapter (couriers never use it): its country's rules check
// the canonical fields, a minimal one only its country, admin area and postal
// code (what tax regions match on).
import { orders } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import {
    matchAdminArea,
    normalizeAddressText,
    normalizePostalCode,
    validatePostalAddress,
    type PostalAddress,
} from "@scalius/shared/address";
import { addressRulesFor } from "@scalius/shared/address-metadata";
import {
    BILLING_ADDRESS_INVALID_REASON,
    BILLING_ADDRESS_REQUIRED_REASON,
    BILLING_COUNTRY_UNAVAILABLE_REASON,
    MINIMAL_BILLING_IGNORED_FIELDS,
    billingAddressNeed,
    type BillingAddressMode,
    type BillingCheckoutPath,
} from "@scalius/shared/billing-address";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { normalizeMarketCountry } from "@scalius/shared/markets";
import { ValidationError } from "@scalius/core/errors";
import { addressProblemMessage, type AddressProblem } from "../customers";
import type { OrderBillingAddressFields } from "./types";

/** The billing fields an order write sends (checkout, staff, agents). */
export interface OrderBillingAddressInput {
    /** An order that ships: false and a billing country sends a separate address; otherwise the shipping address bills. */
    billingSameAsShipping?: boolean | null;
    billingCountryCode?: string | null;
    billingName?: string | null;
    billingCompany?: string | null;
    billingAddress?: string | null;
    billingAddressLine2?: string | null;
    billingDependentLocality?: string | null;
    billingLocality?: string | null;
    billingAdminArea?: string | null;
    billingPostalCode?: string | null;
    billingPhone?: string | null;
}

/** A resolved billing address: canonical fields and the phone (E.164). */
export interface ResolvedBillingAddress extends PostalAddress {
    phone: string | null;
}

/** A refused billing address: `details.issues` name the canonical fields, as for shipping. */
export class BillingAddressValidationError extends ValidationError {
    readonly issues: AddressProblem[];
    constructor(issues: AddressProblem[]) {
        super(`Billing address: ${addressProblemMessage(issues[0]!)}`, { reason: BILLING_ADDRESS_INVALID_REASON, issues });
        this.issues = issues;
    }
}

/** Whether an input names a billing address (its country). */
export function hasBillingAddressInput(input: Pick<OrderBillingAddressInput, "billingCountryCode">): boolean {
    return typeof input.billingCountryCode === "string" && input.billingCountryCode.trim().length > 0;
}

/**
 * Resolves a billing address by its country's rules. `minimal` keeps only the
 * country, the admin area and the postal code (each required when the rules
 * require it). Staff (never buyers) may keep one that breaks the rules,
 * marked validation_skipped; a too-long value is never kept.
 */
export function resolveBillingAddress(
    input: OrderBillingAddressInput,
    options: { mode?: BillingAddressMode; skipValidation?: boolean } = {},
): ResolvedBillingAddress {
    const countryCode = normalizeMarketCountry(input.billingCountryCode);
    const rules = countryCode ? addressRulesFor(countryCode) : null;
    if (!countryCode || !rules) throw new BillingAddressValidationError([{ field: "countryCode", code: "unknown_country" }]);
    const ignore = options.mode === "minimal" ? MINIMAL_BILLING_IGNORED_FIELDS : [];
    const canonical = {
        countryCode,
        name: input.billingName,
        company: input.billingCompany,
        line1: input.billingAddress,
        line2: input.billingAddressLine2,
        dependentLocality: input.billingDependentLocality,
        locality: input.billingLocality,
        adminArea: input.billingAdminArea,
        postalCode: input.billingPostalCode,
    };
    const validated = validatePostalAddress(canonical, rules, { ignore });
    const problems: AddressProblem[] = [...validated.issues];
    const phoneRaw = normalizeAddressText(input.billingPhone);
    let phone: string | null = null;
    if (phoneRaw) {
        try {
            phone = validateAndFormatPhone(phoneRaw, undefined, { defaultCountry: countryCode });
        } catch {
            problems.push({ field: "phone", code: "invalid" });
        }
    }
    const tooLong = problems.filter((problem) => problem.code === "too_long");
    if (tooLong.length > 0) throw new BillingAddressValidationError(tooLong);
    if (problems.length > 0 && options.skipValidation !== true) throw new BillingAddressValidationError(problems);
    const address = problems.length > 0
        ? { ...validatePostalAddress(canonical, rules, { ignore, skipValidation: true }).address, validationSkipped: true }
        : validated.address;
    return { ...address, phone };
}

/**
 * Where tax regions locate a billing address while the buyer types it (the
 * tax quote): its country, its admin area as the rules' code when one
 * matches, and its postal code. Null without a known country.
 */
export function billingTaxLocation(
    input: Pick<OrderBillingAddressInput, "billingCountryCode" | "billingAdminArea" | "billingPostalCode">,
): { countryCode: string; adminArea: string | null; postalCode: string | null } | null {
    const countryCode = normalizeMarketCountry(input.billingCountryCode);
    const rules = countryCode ? addressRulesFor(countryCode) : null;
    if (!countryCode || !rules) return null;
    const typed = normalizeAddressText(input.billingAdminArea);
    const adminArea = typed && rules.adminAreas.length > 0 ? matchAdminArea(rules, typed)?.code ?? typed : typed;
    return { countryCode, adminArea, postalCode: normalizePostalCode(input.billingPostalCode) };
}

export interface CheckoutBillingAddress {
    /** The shipping address bills (an order that ships, by default). */
    sameAsShipping: boolean;
    /** A separate billing address; null when the shipping address bills or none is needed. */
    address: ResolvedBillingAddress | null;
}

/**
 * The billing address of a checkout or agent order (Shopify's rule):
 *
 * - `delivery`: the shipping address bills; when the merchant requires a
 *   full billing address, the buyer may untick "Same as shipping address"
 *   and send one;
 * - `pickup`: none, unless the merchant requires a full one;
 * - `none` (nothing physical): always one, minimal unless the merchant
 *   requires a full one. Without a country, the store's only selling country.
 *
 * A billing country must be one an active market sells to.
 */
export function resolveCheckoutBillingAddress(
    input: OrderBillingAddressInput,
    options: {
        path: BillingCheckoutPath;
        requireFullBillingAddress: boolean;
        /** The countries the active markets sell to (the authority read). */
        sellingCountries?: readonly string[];
    },
): CheckoutBillingAddress {
    const need = billingAddressNeed({ path: options.path, requireFullBillingAddress: options.requireFullBillingAddress });
    // Not asked: an order that ships is billed at its shipping address, a
    // pickup order has none, whatever was sent.
    if (!need.asked) return options.path === "delivery" ? { sameAsShipping: true, address: null } : { sameAsShipping: false, address: null };
    const sent = hasBillingAddressInput(input);
    if (options.path === "delivery" && (input.billingSameAsShipping !== false || !sent)) {
        if (input.billingSameAsShipping === false) {
            throw new ValidationError("Enter the billing address, or tick “Same as shipping address”.", { reason: BILLING_ADDRESS_REQUIRED_REASON });
        }
        return { sameAsShipping: true, address: null };
    }
    const selling = options.sellingCountries ?? [];
    const country = sent
        ? input.billingCountryCode
        : options.path === "none" && selling.length === 1 ? selling[0] : null;
    if (!country) {
        // A direct core caller without the store's countries places it as before (taxed at the origin).
        if (options.sellingCountries === undefined) return { sameAsShipping: false, address: null };
        throw new ValidationError("Enter the billing address country.", { reason: BILLING_ADDRESS_REQUIRED_REASON });
    }
    const countryCode = normalizeMarketCountry(country);
    if (options.sellingCountries && (!countryCode || !options.sellingCountries.includes(countryCode))) {
        throw new ValidationError("We can't take a billing address in this country.", {
            reason: BILLING_COUNTRY_UNAVAILABLE_REASON,
            countryCode: countryCode ?? null,
        });
    }
    return {
        sameAsShipping: false,
        address: resolveBillingAddress({ ...input, billingCountryCode: countryCode }, { mode: need.mode }),
    };
}

/**
 * A staff or edited order's billing address (Shopify's draft orders): an
 * order that ships uses its shipping address unless `billingSameAsShipping`
 * is false; otherwise the address is optional. With a street line it is
 * checked as a full address, without one as a minimal one (country, region,
 * postal code). Staff may keep one that breaks its rules (marked). Null: no
 * billing address.
 */
export function resolveStaffBillingAddress(
    input: OrderBillingAddressInput,
    options: { ships: boolean; skipValidation?: boolean },
): CheckoutBillingAddress | null {
    if (options.ships && input.billingSameAsShipping !== false) return { sameAsShipping: true, address: null };
    if (!hasBillingAddressInput(input)) return null;
    return {
        sameAsShipping: false,
        address: resolveBillingAddress(input, {
            mode: input.billingAddress?.trim() ? "full" : "minimal",
            skipValidation: options.skipValidation,
        }),
    };
}

/** No billing address: every order placed before 0119, and pickup orders that were not asked. */
export const NO_ORDER_BILLING_ADDRESS: OrderBillingAddressFields = {
    billingSameAsShipping: false,
    billingName: null,
    billingCompany: null,
    billingAddress: null,
    billingAddressLine2: null,
    billingCountryCode: null,
    billingDependentLocality: null,
    billingLocality: null,
    billingAdminArea: null,
    billingPostalCode: null,
    billingPhone: null,
    billingValidationSkipped: false,
};

/**
 * The order columns of a billing address. `contact` is the order's contact:
 * a name or phone equal to it is stored as null (null means the contact).
 */
export function orderBillingAddressColumns(
    billing: CheckoutBillingAddress | null,
    contact: { name?: string | null; phone?: string | null } = {},
): OrderBillingAddressFields {
    if (!billing) return NO_ORDER_BILLING_ADDRESS;
    if (billing.sameAsShipping) return { ...NO_ORDER_BILLING_ADDRESS, billingSameAsShipping: true };
    const address = billing.address;
    if (!address) return NO_ORDER_BILLING_ADDRESS;
    return {
        billingSameAsShipping: false,
        billingName: address.name && address.name !== contact.name?.trim() ? address.name : null,
        billingCompany: address.company,
        billingAddress: address.line1,
        billingAddressLine2: address.line2,
        billingCountryCode: address.countryCode,
        billingDependentLocality: address.dependentLocality,
        billingLocality: address.locality,
        billingAdminArea: address.adminArea,
        billingPostalCode: address.postalCode,
        billingPhone: address.phone && address.phone !== contact.phone ? address.phone : null,
        billingValidationSkipped: address.validationSkipped,
    };
}

/**
 * The billing snapshot for an order insert, picked from a wider payload.
 * Absent values are left out and both flags are SQL literals: the order
 * insert binds close to D1's 100 parameters, and Drizzle would otherwise bind
 * each flag's default. A shipped order billed at its shipping address binds
 * nothing for its billing address.
 */
export function orderBillingAddressInsertColumns(fields: Partial<OrderBillingAddressFields>): Partial<Omit<OrderBillingAddressFields, "billingSameAsShipping" | "billingValidationSkipped">> & {
    billingSameAsShipping: SQL;
    billingValidationSkipped: SQL;
} {
    const columns: Partial<OrderBillingAddressFields> = {};
    for (const key of Object.keys(NO_ORDER_BILLING_ADDRESS) as Array<keyof OrderBillingAddressFields>) {
        if (key === "billingSameAsShipping" || key === "billingValidationSkipped") continue;
        const value = fields[key];
        if (value !== null && value !== undefined) (columns as Record<string, unknown>)[key] = value;
    }
    return {
        ...(columns as Partial<Omit<OrderBillingAddressFields, "billingSameAsShipping" | "billingValidationSkipped">>),
        billingSameAsShipping: sql.raw(fields.billingSameAsShipping === true ? "1" : "0"),
        billingValidationSkipped: sql.raw(fields.billingValidationSkipped === true ? "1" : "0"),
    };
}

/** The snapshot's columns for a select. */
export function orderBillingAddressSelection(table: typeof orders = orders) {
    return {
        billingSameAsShipping: table.billingSameAsShipping,
        billingName: table.billingName,
        billingCompany: table.billingCompany,
        billingAddress: table.billingAddress,
        billingAddressLine2: table.billingAddressLine2,
        billingCountryCode: table.billingCountryCode,
        billingDependentLocality: table.billingDependentLocality,
        billingLocality: table.billingLocality,
        billingAdminArea: table.billingAdminArea,
        billingPostalCode: table.billingPostalCode,
        billingPhone: table.billingPhone,
        billingValidationSkipped: table.billingValidationSkipped,
    } as const;
}

/** The billing snapshot picked field by field from a wider row (never spread). */
export function orderBillingAddressFields(row: Partial<OrderBillingAddressFields>): OrderBillingAddressFields {
    return {
        billingSameAsShipping: row.billingSameAsShipping === true,
        billingName: row.billingName ?? null,
        billingCompany: row.billingCompany ?? null,
        billingAddress: row.billingAddress ?? null,
        billingAddressLine2: row.billingAddressLine2 ?? null,
        billingCountryCode: row.billingCountryCode ?? null,
        billingDependentLocality: row.billingDependentLocality ?? null,
        billingLocality: row.billingLocality ?? null,
        billingAdminArea: row.billingAdminArea ?? null,
        billingPostalCode: row.billingPostalCode ?? null,
        billingPhone: row.billingPhone ?? null,
        billingValidationSkipped: row.billingValidationSkipped === true,
    };
}

