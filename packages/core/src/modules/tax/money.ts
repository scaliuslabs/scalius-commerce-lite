const MAX_MINOR_AMOUNT = 9_000_000_000_000;

function assertMinorAmount(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MINOR_AMOUNT) {
        throw new RangeError(`${label} must be a safe non-negative minor-unit integer.`);
    }
    return value;
}

/**
 * `amountMinor × rateBps`, rounded half-up to `unitMinor` (100 for BDT cash
 * rounding, so tax is whole taka; 1 keeps full minor-unit precision).
 */
export function multiplyMinorByRate(amountMinor: number, rateBps: number, unitMinor = 1): number {
    assertMinorAmount(amountMinor, "Tax base");
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
        throw new RangeError("Tax rate must be an integer between 0 and 10000 basis points.");
    }
    const unit = BigInt(unitMinor);
    const numerator = BigInt(amountMinor) * BigInt(rateBps);
    const rounded = ((numerator + 5_000n * unit) / (10_000n * unit)) * unit;
    const result = Number(rounded);
    return assertMinorAmount(result, "Tax amount");
}

/** Half-up to a multiple of `unitMinor`. */
export function roundToUnit(amountMinor: number, unitMinor: number): number {
    return unitMinor <= 1 ? amountMinor : Math.floor((amountMinor + unitMinor / 2) / unitMinor) * unitMinor;
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
    unitMinor = 1,
): Map<string, number> {
    // Whole cash units over whole-unit weights stay whole (BDT: no paisa per line).
    if (unitMinor > 1 && amountMinor % unitMinor === 0 && weights.every(({ weightMinor }) => weightMinor % unitMinor === 0)) {
        const units = allocateMinorAmount(
            amountMinor / unitMinor,
            weights.map(({ key, weightMinor }) => ({ key, weightMinor: weightMinor / unitMinor })),
        );
        return new Map([...units].map(([key, part]) => [key, part * unitMinor]));
    }
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
