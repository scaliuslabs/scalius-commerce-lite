// The tax quote (MARKETS-DESIGN D8): the platform resolves the order's
// region and provider, allocates discounts, asks the provider for the tax of
// each taxable line and of shipping (the tax provider port), and builds the
// quote the order keeps. The built-in system provider is
// `calculateSystemTax`: the merchant's rates of the address's regions
// (`region-match.ts`), exclusive or included in the price, rounded half-up
// to the market's price increment.
import type { TaxCalculateInput, TaxCalculation, TaxCalculationLine } from "@scalius/shared/plugins/providers/tax";
import { ValidationError } from "@scalius/core/errors";
import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
import { allocateMinorAmount, multiplyMinorByRate, roundToUnit } from "./money";
import {
    isCountryTaxRegion,
    matchTaxRegions,
    ratesForTaxClass,
    taxCountryOf,
    taxProviderIdFor,
} from "./region-match";
import {
    SYSTEM_TAX_PROVIDER_ID,
    type CalculateTaxQuoteInput,
    type TaxClassDefinition,
    type TaxComponentSnapshot,
    type TaxJurisdictionType,
    type TaxQuote,
    type TaxRateDefinition,
    type TaxRegionDefinition,
} from "./types";

/** Why checkout refuses while the tax provider cannot answer (fail closed). */
export const TAX_UNAVAILABLE_REASON = "tax_unavailable";

/** The order cannot be taxed now: checkout refuses rather than charging no tax. */
export function taxUnavailable(message = "Tax can't be calculated right now. Please try again shortly."): ValidationError {
    return new ValidationError(message, { reason: TAX_UNAVAILABLE_REASON });
}

// ── The system provider ────────────────────────────────────────────────────

/** What the built-in provider calculates with: the store's tax authority. */
export interface SystemTaxSettings {
    classes: readonly TaxClassDefinition[];
    regions: readonly TaxRegionDefinition[];
    /** Active rates. */
    rates: readonly TaxRateDefinition[];
    defaultTaxClassId: string | null;
    /** Tax rounds half-up to it (the market's price increment). */
    priceIncrementMinor: number;
}

interface AmountTax {
    taxableAmountMinor: number;
    taxMinor: number;
    components: Array<{ rate: TaxRateDefinition; amountMinor: number }>;
}

function exclusiveComponents(
    baseMinor: number,
    rates: readonly TaxRateDefinition[],
    unitMinor: number,
): Array<{ rate: TaxRateDefinition; amountMinor: number }> {
    // Priority is a calculation layer, not merely a display order. Rates in
    // the same layer must see the same base; otherwise the opaque rate id
    // tie-breaker can change compound tax. Only completed, lower-priority
    // layers participate in a compound rate's base.
    let currentPriority: number | null = null;
    let completedPriorityTaxMinor = 0;
    let currentPriorityTaxMinor = 0;
    return rates.map((rate) => {
        if (currentPriority === null) {
            currentPriority = rate.priority;
        } else if (rate.priority !== currentPriority) {
            completedPriorityTaxMinor += currentPriorityTaxMinor;
            currentPriorityTaxMinor = 0;
            currentPriority = rate.priority;
        }
        const componentBase = rate.isCompound
            ? baseMinor + completedPriorityTaxMinor
            : baseMinor;
        const amountMinor = multiplyMinorByRate(componentBase, rate.rateBps, unitMinor);
        currentPriorityTaxMinor += amountMinor;
        return { rate, amountMinor };
    });
}

const componentTotal = (components: ReadonlyArray<{ amountMinor: number }>) =>
    components.reduce((sum, component) => sum + component.amountMinor, 0);

function inclusiveTax(grossMinor: number, rates: readonly TaxRateDefinition[], unitMinor: number): AmountTax {
    if (grossMinor === 0 || rates.length === 0) {
        return { taxableAmountMinor: rates.length > 0 ? grossMinor : 0, taxMinor: 0, components: [] };
    }

    let low = 0;
    let high = grossMinor;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const components = exclusiveComponents(mid, rates, 1);
        const inclusiveTotal = mid + componentTotal(components);
        if (inclusiveTotal <= grossMinor) low = mid;
        else high = mid - 1;
    }

    // The included tax is shown in whole increments (a BDT store's default: whole taka).
    const taxMinor = Math.min(grossMinor, roundToUnit(grossMinor - low, unitMinor));
    const taxableAmountMinor = grossMinor - taxMinor;
    const components = exclusiveComponents(taxableAmountMinor, rates, unitMinor);
    const componentRemainder = taxMinor - componentTotal(components);
    if (componentRemainder !== 0 && components.length > 0) {
        const last = components[components.length - 1]!;
        last.amountMinor += componentRemainder;
    }
    return { taxableAmountMinor, taxMinor, components };
}

function amountTax(netMinor: number, rates: readonly TaxRateDefinition[], pricesIncludeTax: boolean, unitMinor: number): AmountTax {
    if (rates.length === 0) return { taxableAmountMinor: 0, taxMinor: 0, components: [] };
    if (pricesIncludeTax) return inclusiveTax(netMinor, rates, unitMinor);
    const components = exclusiveComponents(netMinor, rates, unitMinor);
    return { taxableAmountMinor: netMinor, taxMinor: componentTotal(components), components };
}

/**
 * The system provider's `calculate`: for each line, the rates of its tax
 * class at the destination (`ratesForTaxClass`); an exempt or unknown class
 * pays none. Every tax line names its rate (`rateRef`) and region.
 */
export function calculateSystemTax(input: TaxCalculateInput, settings: SystemTaxSettings): TaxCalculation {
    const chain = matchTaxRegions(input.destination, settings.regions);
    const classes = new Map(settings.classes.map((taxClass) => [taxClass.id, taxClass]));
    const unitMinor = settings.priceIncrementMinor;
    const taxesOf = (amountMinor: number, taxCode: string | null | undefined): TaxCalculationLine[] => {
        const taxClass = classes.get(taxCode ?? settings.defaultTaxClassId ?? "");
        if (!taxClass || taxClass.isExempt) return [];
        const { rates } = ratesForTaxClass(chain, settings.rates, taxClass.id);
        return amountTax(amountMinor, rates, input.pricesIncludeTax, unitMinor).components.map(({ rate, amountMinor: taxMinor }) => ({
            taxMinor,
            rateBps: rate.rateBps,
            jurisdiction: rate.taxRegionId,
            name: rate.name,
            rateRef: rate.id,
        }));
    };
    return {
        calculationId: `${SYSTEM_TAX_PROVIDER_ID}:${input.idempotencyKey}`.slice(0, 256),
        lines: input.lines.map((line) => ({ lineId: line.lineId, taxes: taxesOf(line.amountMinor, line.taxCode) })),
        shipping: input.shippingTaxCode === undefined ? [] : taxesOf(input.shippingMinor, input.shippingTaxCode),
    };
}

// ── The quote ──────────────────────────────────────────────────────────────

function assertInput(input: CalculateTaxQuoteInput): void {
    if (!Number.isInteger(input.decimalPlaces) || input.decimalPlaces < 0 || input.decimalPlaces > 3) {
        throw new RangeError("Currency decimal places must be between 0 and 3.");
    }
    if (!Number.isSafeInteger(input.priceIncrementMinor) || input.priceIncrementMinor < 1) {
        throw new RangeError("The price increment must be a positive integer of minor units.");
    }
    for (const line of input.lines) {
        if (!line.lineId || !line.productId || !line.variantId) throw new RangeError("Tax quote lines require stable ids.");
        if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) throw new RangeError("Tax quote line price is invalid.");
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_LINE_QUANTITY) throw new RangeError("Tax quote line quantity is invalid.");
    }
    if (!Number.isSafeInteger(input.shippingMinor) || input.shippingMinor < 0) {
        throw new RangeError("Tax quote shipping amount is invalid.");
    }
    if (!Number.isSafeInteger(input.discountMinor) || input.discountMinor < 0) {
        throw new RangeError("Tax quote discount amount is invalid.");
    }
}

function resolveDiscountAllocation(
    input: CalculateTaxQuoteInput,
    subtotalMinor: number,
): { discountMinor: number; allocations: Map<string, number> } {
    const grossBeforeDiscountMinor = subtotalMinor + input.shippingMinor;
    const requestedMinor = Math.min(input.discountMinor, grossBeforeDiscountMinor);
    if (!input.discountAllocation) {
        // Generic previews have no validated discount domain metadata. Keep the
        // fallback product-only so shipping is never discounted accidentally.
        const discountMinor = Math.min(requestedMinor, subtotalMinor);
        return {
            discountMinor,
            allocations: allocateMinorAmount(discountMinor, input.lines.map((line) => ({
                key: `line:${line.lineId}`,
                weightMinor: line.unitPriceMinor * line.quantity,
            })), input.priceIncrementMinor),
        };
    }

    const grossByLineId = new Map(input.lines.map((line) => [
        line.lineId,
        line.unitPriceMinor * line.quantity,
    ]));
    if (grossByLineId.size !== input.lines.length) {
        throw new RangeError("Tax quote line ids must be unique.");
    }
    const allocations = new Map(input.lines.map((line) => [`line:${line.lineId}`, 0]));
    const seenLineIds = new Set<string>();
    let allocatedMinor = 0;
    for (const allocation of input.discountAllocation.lines) {
        const grossMinor = grossByLineId.get(allocation.lineId);
        if (grossMinor === undefined || seenLineIds.has(allocation.lineId)) {
            throw new RangeError("Tax discount allocation contains an invalid line id.");
        }
        if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor < 0 || allocation.amountMinor > grossMinor) {
            throw new RangeError("Tax discount line allocation is invalid.");
        }
        seenLineIds.add(allocation.lineId);
        allocations.set(`line:${allocation.lineId}`, allocation.amountMinor);
        allocatedMinor += allocation.amountMinor;
    }
    const shippingDiscountMinor = input.discountAllocation.shippingMinor;
    if (
        !Number.isSafeInteger(shippingDiscountMinor) ||
        shippingDiscountMinor < 0 ||
        shippingDiscountMinor > input.shippingMinor
    ) {
        throw new RangeError("Tax discount shipping allocation is invalid.");
    }
    allocatedMinor += shippingDiscountMinor;
    if (!Number.isSafeInteger(allocatedMinor) || allocatedMinor !== requestedMinor) {
        throw new RangeError("Tax discount allocations must equal the bounded discount total.");
    }
    allocations.set("shipping", shippingDiscountMinor);
    return { discountMinor: allocatedMinor, allocations };
}

/** A stable, short idempotency key of a priced cart (two FNV-1a 32-bit passes). */
function cartKey(value: unknown): string {
    const text = JSON.stringify(value);
    let first = 0x811c9dc5;
    let second = 0x01000193;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ code, 0x811c9dc5) >>> 0;
    }
    return `tax:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

interface PreparedPart {
    grossAmountMinor: number;
    discountMinor: number;
    netMinor: number;
    taxClass: TaxClassDefinition | null;
    /** Sent to the provider: a taxable class and a region to tax in. */
    taxed: boolean;
}

/** A quote before its provider answered: what to ask, and of whom. */
export interface PreparedTaxQuote {
    input: CalculateTaxQuoteInput;
    taxEnabled: boolean;
    pricesIncludeTax: boolean;
    subtotalMinor: number;
    discountMinor: number;
    countryCode: string;
    chain: TaxRegionDefinition[];
    /** Null: nothing is taxed (tax off, or no region of the country). */
    providerId: string | null;
    lines: PreparedPart[];
    shipping: PreparedPart;
    /** The provider's input; null when nothing is asked. */
    request: TaxCalculateInput | null;
}

/** Resolves the region, the provider and the taxable amounts (no I/O). */
export function prepareTaxQuote(input: CalculateTaxQuoteInput): PreparedTaxQuote {
    assertInput(input);
    const classMap = new Map(input.classes.map((taxClass) => [taxClass.id, taxClass]));
    const subtotalMinor = input.lines.reduce(
        (sum, line) => sum + line.unitPriceMinor * line.quantity,
        0,
    );
    if (!Number.isSafeInteger(subtotalMinor)) throw new RangeError("Tax quote subtotal exceeds the safe integer range.");
    const grossBeforeDiscountMinor = subtotalMinor + input.shippingMinor;
    if (!Number.isSafeInteger(grossBeforeDiscountMinor)) {
        throw new RangeError("Tax quote total exceeds the safe integer range.");
    }
    const { discountMinor, allocations } = resolveDiscountAllocation(input, subtotalMinor);

    const taxEnabled = input.settings.enabled === true;
    const destination = input.destination;
    const countryCode = taxCountryOf(destination, input.originCountry);
    // An address: a Bangladesh place or another country's; none: taxed where the store ships from.
    const hasAddress = Boolean(destination.city) || Boolean(destination.countryCode);
    const locationIds = hasAddress
        ? [destination.area, destination.zone, destination.city].filter((id): id is string => Boolean(id))
        : [];
    const address = {
        country: countryCode,
        adminArea: hasAddress ? destination.adminArea?.trim() || null : null,
        city: hasAddress ? destination.cityName ?? null : null,
        postalCode: hasAddress ? destination.postalCode?.trim() || null : null,
        ...(locationIds.length > 0 ? { locationIds } : {}),
    };
    const chain = taxEnabled ? matchTaxRegions(address, input.regions) : [];
    const providerId = taxEnabled ? taxProviderIdFor(chain, input.settings.providerId) : null;
    const taxable = (taxClass: TaxClassDefinition | null) => providerId !== null && taxClass !== null && !taxClass.isExempt;

    const lines = input.lines.map((line): PreparedPart => {
        const grossAmountMinor = line.unitPriceMinor * line.quantity;
        const lineDiscountMinor = allocations.get(`line:${line.lineId}`) ?? 0;
        const configuredClassId = line.taxExempt === true ? null : line.taxClassId ?? input.settings.defaultTaxClassId;
        const taxClass = taxEnabled && configuredClassId ? classMap.get(configuredClassId) ?? null : null;
        return {
            grossAmountMinor,
            discountMinor: lineDiscountMinor,
            netMinor: grossAmountMinor - lineDiscountMinor,
            taxClass,
            taxed: taxable(taxClass),
        };
    });
    const shippingDiscountMinor = allocations.get("shipping") ?? 0;
    const shippingClassId = input.settings.shippingTaxClassId ?? input.settings.defaultTaxClassId;
    const shippingClass = taxEnabled && input.settings.taxShipping && shippingClassId
        ? classMap.get(shippingClassId) ?? null
        : null;
    const shipping: PreparedPart = {
        grossAmountMinor: input.shippingMinor,
        discountMinor: shippingDiscountMinor,
        netMinor: input.shippingMinor - shippingDiscountMinor,
        taxClass: shippingClass,
        taxed: taxable(shippingClass),
    };

    const pricesIncludeTax = input.pricesIncludeTax === true;
    const request: TaxCalculateInput | null = providerId === null ? null : {
        idempotencyKey: "",
        currency: input.currencyCode,
        pricesIncludeTax,
        destination: address,
        origin: input.originCountry ? { country: input.originCountry, adminArea: null, city: null, postalCode: null } : null,
        lines: input.lines.flatMap((line, index) => lines[index]!.taxed
            ? [{ lineId: line.lineId, taxCode: lines[index]!.taxClass!.id, quantity: line.quantity, amountMinor: lines[index]!.netMinor }]
            : []),
        shippingMinor: shipping.taxed ? shipping.netMinor : 0,
        ...(shipping.taxed ? { shippingTaxCode: shipping.taxClass!.id } : {}),
        customer: null,
    };
    if (request) request.idempotencyKey = input.idempotencyKey ?? cartKey({ ...request, idempotencyKey: undefined });
    return {
        input,
        taxEnabled,
        pricesIncludeTax,
        subtotalMinor,
        discountMinor,
        countryCode,
        chain,
        providerId,
        lines,
        shipping,
        request,
    };
}

/** How a system rate's region is named on a snapshot component (`all`: a whole country). */
function regionScope(region: TaxRegionDefinition | undefined): { jurisdictionType: TaxJurisdictionType; jurisdictionId: string | null } {
    if (!region || isCountryTaxRegion(region)) return { jurisdictionType: "all", jurisdictionId: null };
    if (region.placeType && region.placeId) return { jurisdictionType: region.placeType, jurisdictionId: region.placeId };
    if (region.postalPrefix) return { jurisdictionType: "postal_prefix", jurisdictionId: region.postalPrefix };
    return { jurisdictionType: "admin_area", jurisdictionId: region.adminArea };
}

/**
 * Builds the quote from the provider's answer. The system provider's tax
 * lines name local rates (full snapshot components); an app's are rounded
 * half-up to the price increment and must fit in an inclusive price.
 */
export function completeTaxQuote(prepared: PreparedTaxQuote, calculation: TaxCalculation | null): TaxQuote {
    const { input } = prepared;
    const unitMinor = input.priceIncrementMinor;
    const isSystem = prepared.providerId === SYSTEM_TAX_PROVIDER_ID;
    const ratesById = new Map(input.rates.map((rate) => [rate.id, rate]));
    const regionsById = new Map(input.regions.map((region) => [region.id, region]));
    const chainOrder = new Map(prepared.chain.map((region, index) => [region.id, index]));
    const sentLineIds = new Set(prepared.request?.lines.map((line) => line.lineId) ?? []);
    const answered = new Map<string, TaxCalculationLine[]>();
    for (const line of calculation?.lines ?? []) {
        if (!sentLineIds.has(line.lineId) || answered.has(line.lineId)) {
            throw taxUnavailable("The tax provider answered for a line it was not asked about.");
        }
        answered.set(line.lineId, line.taxes);
    }
    if (calculation && answered.size !== sentLineIds.size) {
        throw taxUnavailable("The tax provider did not answer for every line.");
    }

    const componentsOf = (taxes: readonly TaxCalculationLine[]): { components: TaxComponentSnapshot[]; regionId: string | null } => {
        let regionId: string | null = null;
        const components = taxes.map((tax): TaxComponentSnapshot => {
            const rate = isSystem && tax.rateRef ? ratesById.get(tax.rateRef) : undefined;
            if (rate) {
                const order = chainOrder.get(rate.taxRegionId);
                if (order !== undefined && (regionId === null || order < chainOrder.get(regionId)!)) regionId = rate.taxRegionId;
                return {
                    rateId: rate.id,
                    name: rate.name,
                    rateBps: rate.rateBps,
                    priority: rate.priority,
                    compound: rate.isCompound,
                    ...regionScope(regionsById.get(rate.taxRegionId)),
                    amountMinor: tax.taxMinor,
                };
            }
            return {
                rateId: `${prepared.providerId}:${tax.rateRef ?? tax.jurisdiction}`.slice(0, 180),
                name: tax.name ?? tax.jurisdiction,
                rateBps: tax.rateBps,
                priority: 0,
                compound: false,
                jurisdictionType: "provider",
                jurisdictionId: tax.jurisdiction,
                amountMinor: roundToUnit(tax.taxMinor, unitMinor),
            };
        });
        return { components, regionId };
    };
    const partTax = (part: PreparedPart, taxes: readonly TaxCalculationLine[] | undefined) => {
        const { components, regionId } = part.taxed && taxes ? componentsOf(taxes) : { components: [], regionId: null };
        const taxMinor = componentTotal(components);
        if (prepared.pricesIncludeTax && taxMinor > part.netMinor) {
            throw taxUnavailable("The tax provider returned more tax than the price includes.");
        }
        return {
            taxableAmountMinor: components.length === 0 ? 0 : prepared.pricesIncludeTax ? part.netMinor - taxMinor : part.netMinor,
            taxMinor,
            totalMinor: part.grossAmountMinor - part.discountMinor + (prepared.pricesIncludeTax ? 0 : taxMinor),
            components,
            taxRegionId: regionId,
        };
    };

    const lines = input.lines.map((line, index) => {
        const part = prepared.lines[index]!;
        const tax = partTax(part, answered.get(line.lineId));
        return {
            lineId: line.lineId,
            productId: line.productId,
            variantId: line.variantId,
            taxClassId: part.taxClass?.id ?? null,
            taxClassName: part.taxClass?.name ?? null,
            unitPriceMinor: line.unitPriceMinor,
            quantity: line.quantity,
            grossAmountMinor: part.grossAmountMinor,
            discountMinor: part.discountMinor,
            ...tax,
        };
    });
    const shippingTax = partTax(prepared.shipping, calculation?.shipping);
    const shipping = {
        taxClassId: prepared.shipping.taxClass?.id ?? null,
        taxClassName: prepared.shipping.taxClass?.name ?? null,
        grossAmountMinor: prepared.shipping.grossAmountMinor,
        discountMinor: prepared.shipping.discountMinor,
        ...shippingTax,
    };

    // Whether rates apply to shipping: an included tax on free shipping has no
    // component, yet the system provider's rates still apply there.
    const shippingRatesApply = shipping.components.length > 0 || (
        isSystem && prepared.shipping.taxed
        && ratesForTaxClass(prepared.chain, input.rates, prepared.shipping.taxClass!.id).rates.length > 0
    );
    const taxMinor = lines.reduce((sum, line) => sum + line.taxMinor, shipping.taxMinor);
    const taxableMinor = lines.reduce((sum, line) => sum + line.taxableAmountMinor, shipping.taxableAmountMinor);
    const totalMinor = prepared.subtotalMinor + input.shippingMinor - prepared.discountMinor + (
        prepared.pricesIncludeTax ? 0 : taxMinor
    );
    const destination = input.destination;

    return {
        schemaVersion: 1,
        calculationVersion: "tax-v1",
        enabled: prepared.taxEnabled,
        currencyCode: input.currencyCode,
        decimalPlaces: input.decimalPlaces,
        displayLabel: input.settings.displayLabel,
        pricesIncludeTax: prepared.taxEnabled && prepared.pricesIncludeTax,
        shippingTaxed: prepared.taxEnabled && input.settings.taxShipping && shippingRatesApply,
        settingsVersion: input.settings.version,
        subtotalMinor: prepared.subtotalMinor,
        shippingMinor: input.shippingMinor,
        discountMinor: prepared.discountMinor,
        taxableMinor,
        taxMinor,
        totalMinor,
        // The order's destination snapshot: the Bangladesh hierarchy fields, as before regions.
        destination: {
            city: destination.city,
            zone: destination.zone,
            area: destination.area,
            ...(destination.cityName !== undefined ? { cityName: destination.cityName } : {}),
            ...(destination.zoneName !== undefined ? { zoneName: destination.zoneName } : {}),
            ...(destination.areaName !== undefined ? { areaName: destination.areaName } : {}),
        },
        jurisdiction: {
            countryCode: prepared.countryCode,
            providerId: prepared.providerId ?? input.settings.providerId,
            calculationId: calculation && !isSystem ? calculation.calculationId : null,
            addressSource: Boolean(destination.city) || Boolean(destination.countryCode)
                ? input.addressSource ?? "shipping"
                : "origin",
        },
        lines,
        shipping,
    };
}

/** The settings the system provider calculates a prepared quote with. */
export function systemTaxSettingsOf(input: CalculateTaxQuoteInput): SystemTaxSettings {
    return {
        classes: input.classes,
        regions: input.regions,
        rates: input.rates,
        defaultTaxClassId: input.settings.defaultTaxClassId,
        priceIncrementMinor: input.priceIncrementMinor,
    };
}

/**
 * The quote by the built-in system provider, synchronously (previews and
 * tests). Checkout asks `quoteTax`, which selects the provider and fails
 * closed; an address whose region names an app provider is refused here.
 */
export function calculateTaxQuote(input: CalculateTaxQuoteInput): TaxQuote {
    const prepared = prepareTaxQuote(input);
    if (prepared.providerId !== null && prepared.providerId !== SYSTEM_TAX_PROVIDER_ID) {
        throw taxUnavailable("This address is taxed by an app provider; ask it through checkout.");
    }
    const calculation = prepared.request ? calculateSystemTax(prepared.request, systemTaxSettingsOf(input)) : null;
    return completeTaxQuote(prepared, calculation);
}
