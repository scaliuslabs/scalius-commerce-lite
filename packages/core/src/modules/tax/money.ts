import currency from "currency.js";

const MAX_MINOR_AMOUNT = 9_000_000_000_000;

function assertMinorAmount(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MINOR_AMOUNT) {
        throw new RangeError(`${label} must be a safe non-negative minor-unit integer.`);
    }
    return value;
}

export function toMinorUnits(amount: number, decimalPlaces: number): number {
    if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError("Money amount must be finite and non-negative.");
    }
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 3) {
        throw new RangeError("Currency decimal places must be an integer between 0 and 3.");
    }
    return assertMinorAmount(currency(amount, { precision: decimalPlaces }).intValue, "Money amount");
}

export function fromMinorUnits(amountMinor: number, decimalPlaces: number): number {
    assertMinorAmount(amountMinor, "Money amount");
    return amountMinor / 10 ** decimalPlaces;
}

export function multiplyMinorByRate(amountMinor: number, rateBps: number): number {
    assertMinorAmount(amountMinor, "Tax base");
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
        throw new RangeError("Tax rate must be an integer between 0 and 10000 basis points.");
    }
    const numerator = BigInt(amountMinor) * BigInt(rateBps);
    const rounded = (numerator + 5_000n) / 10_000n;
    const result = Number(rounded);
    return assertMinorAmount(result, "Tax amount");
}

export interface AllocationWeight {
    key: string;
    weightMinor: number;
}

/**
 * Allocates a bounded amount proportionally with largest-remainder rounding.
 * Stable key ordering resolves exact remainder ties, making retries identical.
 */
export function allocateMinorAmount(
    amountMinor: number,
    weights: AllocationWeight[],
): Map<string, number> {
    assertMinorAmount(amountMinor, "Allocation amount");
    const normalized = weights.map((entry) => ({
        key: entry.key,
        weightMinor: assertMinorAmount(entry.weightMinor, `Allocation weight ${entry.key}`),
    }));
    if (new Set(normalized.map((entry) => entry.key)).size !== normalized.length) {
        throw new RangeError("Allocation keys must be unique.");
    }
    const totalWeight = normalized.reduce((sum, entry) => sum + entry.weightMinor, 0);
    if (!Number.isSafeInteger(totalWeight) || totalWeight < 0) {
        throw new RangeError("Allocation weights exceed the safe integer range.");
    }

    const boundedAmount = Math.min(amountMinor, totalWeight);
    const allocations = new Map<string, number>(normalized.map((entry) => [entry.key, 0]));
    if (boundedAmount === 0 || totalWeight === 0) return allocations;

    const denominator = BigInt(totalWeight);
    const shares = normalized.map((entry) => {
        const numerator = BigInt(boundedAmount) * BigInt(entry.weightMinor);
        const floor = Number(numerator / denominator);
        allocations.set(entry.key, floor);
        return { entry, remainder: numerator % denominator, floor };
    });

    let remainderUnits = boundedAmount - shares.reduce((sum, share) => sum + share.floor, 0);
    shares.sort((left, right) => {
        if (left.remainder === right.remainder) return left.entry.key.localeCompare(right.entry.key);
        return left.remainder > right.remainder ? -1 : 1;
    });
    for (const share of shares) {
        if (remainderUnits <= 0) break;
        allocations.set(share.entry.key, (allocations.get(share.entry.key) ?? 0) + 1);
        remainderUnits -= 1;
    }
    return allocations;
}
