import { allocateMinorAmount, multiplyMinorByRate } from "./money";
import type {
    CalculateTaxQuoteInput,
    TaxClassDefinition,
    TaxComponentSnapshot,
    TaxDestination,
    TaxQuote,
    TaxRateDefinition,
} from "./types";

function matchesDestination(rate: TaxRateDefinition, destination: TaxDestination): boolean {
    if (rate.jurisdictionType === "all") return rate.jurisdictionId === null;
    const destinationId = rate.jurisdictionType === "city"
        ? destination.city
        : rate.jurisdictionType === "zone"
            ? destination.zone
            : destination.area;
    return destinationId !== null && destinationId === rate.jurisdictionId;
}

function applicableRates(
    taxClass: TaxClassDefinition | null,
    rates: TaxRateDefinition[],
    destination: TaxDestination,
): TaxRateDefinition[] {
    if (!taxClass || taxClass.isExempt) return [];
    return rates
        .filter((rate) => rate.taxClassId === taxClass.id && matchesDestination(rate, destination))
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

function exclusiveComponents(
    baseMinor: number,
    rates: TaxRateDefinition[],
): TaxComponentSnapshot[] {
    let priorTaxMinor = 0;
    return rates.map((rate) => {
        const componentBase = rate.isCompound ? baseMinor + priorTaxMinor : baseMinor;
        const amountMinor = multiplyMinorByRate(componentBase, rate.rateBps);
        priorTaxMinor += amountMinor;
        return {
            rateId: rate.id,
            name: rate.name,
            rateBps: rate.rateBps,
            priority: rate.priority,
            compound: rate.isCompound,
            jurisdictionType: rate.jurisdictionType,
            jurisdictionId: rate.jurisdictionId,
            amountMinor,
        };
    });
}

function componentTotal(components: TaxComponentSnapshot[]): number {
    return components.reduce((sum, component) => sum + component.amountMinor, 0);
}

function inclusiveTax(
    grossMinor: number,
    rates: TaxRateDefinition[],
): { taxableAmountMinor: number; taxMinor: number; components: TaxComponentSnapshot[] } {
    if (grossMinor === 0 || rates.length === 0) {
        return { taxableAmountMinor: rates.length > 0 ? grossMinor : 0, taxMinor: 0, components: [] };
    }

    let low = 0;
    let high = grossMinor;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const components = exclusiveComponents(mid, rates);
        const inclusiveTotal = mid + componentTotal(components);
        if (inclusiveTotal <= grossMinor) low = mid;
        else high = mid - 1;
    }

    const taxableAmountMinor = low;
    const components = exclusiveComponents(taxableAmountMinor, rates);
    const taxMinor = grossMinor - taxableAmountMinor;
    const componentRemainder = taxMinor - componentTotal(components);
    if (componentRemainder !== 0 && components.length > 0) {
        const last = components[components.length - 1]!;
        last.amountMinor += componentRemainder;
    }
    return { taxableAmountMinor, taxMinor, components };
}

function calculateAmountTax(
    netGrossMinor: number,
    rates: TaxRateDefinition[],
    pricesIncludeTax: boolean,
): { taxableAmountMinor: number; taxMinor: number; components: TaxComponentSnapshot[] } {
    if (rates.length === 0) {
        return { taxableAmountMinor: 0, taxMinor: 0, components: [] };
    }
    if (pricesIncludeTax) return inclusiveTax(netGrossMinor, rates);
    const components = exclusiveComponents(netGrossMinor, rates);
    return {
        taxableAmountMinor: netGrossMinor,
        taxMinor: componentTotal(components),
        components,
    };
}

function assertInput(input: CalculateTaxQuoteInput): void {
    if (!Number.isInteger(input.decimalPlaces) || input.decimalPlaces < 0 || input.decimalPlaces > 3) {
        throw new RangeError("Currency decimal places must be between 0 and 3.");
    }
    for (const line of input.lines) {
        if (!line.lineId || !line.productId || !line.variantId) throw new RangeError("Tax quote lines require stable ids.");
        if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) throw new RangeError("Tax quote line price is invalid.");
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw new RangeError("Tax quote line quantity is invalid.");
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
            }))),
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

export function calculateTaxQuote(input: CalculateTaxQuoteInput): TaxQuote {
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
    const lines = input.lines.map((line) => {
        const grossAmountMinor = line.unitPriceMinor * line.quantity;
        const lineDiscountMinor = allocations.get(`line:${line.lineId}`) ?? 0;
        const configuredClassId = line.taxClassId ?? input.settings.defaultTaxClassId;
        const taxClass = taxEnabled && configuredClassId ? classMap.get(configuredClassId) ?? null : null;
        const rates = taxEnabled ? applicableRates(taxClass, input.rates, input.destination) : [];
        const result = calculateAmountTax(
            grossAmountMinor - lineDiscountMinor,
            rates,
            input.settings.pricesIncludeTax,
        );
        return {
            lineId: line.lineId,
            productId: line.productId,
            variantId: line.variantId,
            taxClassId: taxClass?.id ?? null,
            taxClassName: taxClass?.name ?? null,
            unitPriceMinor: line.unitPriceMinor,
            quantity: line.quantity,
            grossAmountMinor,
            discountMinor: lineDiscountMinor,
            taxableAmountMinor: result.taxableAmountMinor,
            taxMinor: result.taxMinor,
            totalMinor: grossAmountMinor - lineDiscountMinor + (input.settings.pricesIncludeTax ? 0 : result.taxMinor),
            components: result.components,
        };
    });

    const shippingDiscountMinor = allocations.get("shipping") ?? 0;
    const shippingClassId = input.settings.shippingTaxClassId ?? input.settings.defaultTaxClassId;
    const shippingClass = taxEnabled && input.settings.taxShipping && shippingClassId
        ? classMap.get(shippingClassId) ?? null
        : null;
    const shippingRates = taxEnabled && input.settings.taxShipping
        ? applicableRates(shippingClass, input.rates, input.destination)
        : [];
    const shippingResult = calculateAmountTax(
        input.shippingMinor - shippingDiscountMinor,
        shippingRates,
        input.settings.pricesIncludeTax,
    );
    const shipping = {
        taxClassId: shippingClass?.id ?? null,
        taxClassName: shippingClass?.name ?? null,
        grossAmountMinor: input.shippingMinor,
        discountMinor: shippingDiscountMinor,
        taxableAmountMinor: shippingResult.taxableAmountMinor,
        taxMinor: shippingResult.taxMinor,
        totalMinor: input.shippingMinor - shippingDiscountMinor + (
            input.settings.pricesIncludeTax ? 0 : shippingResult.taxMinor
        ),
        components: shippingResult.components,
    };

    const taxMinor = lines.reduce((sum, line) => sum + line.taxMinor, shipping.taxMinor);
    const taxableMinor = lines.reduce((sum, line) => sum + line.taxableAmountMinor, shipping.taxableAmountMinor);
    const totalMinor = grossBeforeDiscountMinor - discountMinor + (
        input.settings.pricesIncludeTax ? 0 : taxMinor
    );

    return {
        schemaVersion: 1,
        calculationVersion: "tax-v1",
        enabled: taxEnabled,
        currencyCode: input.currencyCode,
        decimalPlaces: input.decimalPlaces,
        displayLabel: input.settings.displayLabel,
        pricesIncludeTax: taxEnabled && input.settings.pricesIncludeTax,
        shippingTaxed: taxEnabled && input.settings.taxShipping && shippingRates.length > 0,
        settingsVersion: input.settings.version,
        subtotalMinor,
        shippingMinor: input.shippingMinor,
        discountMinor,
        taxableMinor,
        taxMinor,
        totalMinor,
        destination: input.destination,
        lines,
        shipping,
    };
}
