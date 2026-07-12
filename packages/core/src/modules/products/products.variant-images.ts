import { ValidationError } from "@scalius/core/errors";

export type VariantImageAxis = "option1" | "option2";

export interface VariantImageMappingInput {
    imageId: string;
    variantId?: string | null;
    optionAxis?: VariantImageAxis | null;
    optionValue?: string | null;
    sortOrder?: number;
}

export interface VariantImageMappingRecord {
    id: string;
    productId: string;
    imageId: string;
    variantId: string | null;
    optionAxis: VariantImageAxis | null;
    optionValue: string | null;
    normalizedOptionValue: string | null;
    sortOrder: number;
}

interface VariantImageSourceVariant {
    id: string;
    size?: string | null;
    color?: string | null;
    sizeSortOrder?: number | null;
    colorSortOrder?: number | null;
    isDefault?: boolean | null;
    deletedAt?: Date | string | number | null;
    createdAt?: Date | string | number | null;
}

export function normalizeVariantImageOptionValue(value: string): string {
    return value.trim().toLocaleLowerCase("en-US");
}

function timestampOrder(value: Date | string | number | null | undefined): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

export function getOrderedVariantImageOptionValues(
    variants: readonly VariantImageSourceVariant[],
    axis: VariantImageAxis,
): string[] {
    const ordered = variants
        .filter((variant) => !variant.isDefault && !variant.deletedAt)
        .map((variant) => ({
            id: variant.id,
            value: (axis === "option1" ? variant.size : variant.color)?.trim() ?? "",
            primaryOrder: axis === "option1"
                ? variant.sizeSortOrder ?? 0
                : variant.colorSortOrder ?? 0,
            secondaryOrder: axis === "option1"
                ? variant.colorSortOrder ?? 0
                : variant.sizeSortOrder ?? 0,
            createdAt: timestampOrder(variant.createdAt),
        }))
        .filter((variant) => variant.value)
        .sort((left, right) =>
            left.primaryOrder - right.primaryOrder
            || left.secondaryOrder - right.secondaryOrder
            || left.createdAt - right.createdAt
            || left.id.localeCompare(right.id)
        );

    const seen = new Set<string>();
    return ordered.flatMap((variant) => {
        if (seen.has(variant.value)) return [];
        seen.add(variant.value);
        return [variant.value];
    });
}

export function prepareVariantImageMappingsForWrite(params: {
    productId: string;
    enabled: boolean;
    axis: VariantImageAxis;
    mappings: readonly VariantImageMappingInput[];
    imageIdMap: ReadonlyMap<string, string>;
    variants: readonly VariantImageSourceVariant[];
    createId: () => string;
}): VariantImageMappingRecord[] {
    if (!params.enabled) return [];

    const variants = params.variants.filter((variant) => !variant.deletedAt);
    const variantById = new Map(variants.map((variant) => [variant.id, variant]));
    const optionValueByKey = new Map(
        getOrderedVariantImageOptionValues(variants, params.axis).map((value) => [
            normalizeVariantImageOptionValue(value),
            value,
        ]),
    );
    const usedImageIds = new Set<string>();

    return params.mappings.map((mapping, index) => {
        const imageId = params.imageIdMap.get(mapping.imageId);
        if (!imageId) {
            throw new ValidationError("A variant image mapping references an image that is not on this product.");
        }
        if (usedImageIds.has(imageId)) {
            throw new ValidationError("Each product image may be mapped only once.");
        }
        usedImageIds.add(imageId);

        const sortOrder = mapping.sortOrder ?? index;
        if (!Number.isInteger(sortOrder) || sortOrder < 0) {
            throw new ValidationError("Variant image mapping order must be a non-negative whole number.");
        }

        if (mapping.variantId) {
            const variant = variantById.get(mapping.variantId);
            if (!variant || variant.isDefault) {
                throw new ValidationError("A variant image mapping references a SKU that is not on this product.");
            }
            if (mapping.optionAxis || mapping.optionValue) {
                throw new ValidationError("Map an image to either one SKU or one option value, not both.");
            }
            return {
                id: params.createId(),
                productId: params.productId,
                imageId,
                variantId: mapping.variantId,
                optionAxis: null,
                optionValue: null,
                normalizedOptionValue: null,
                sortOrder,
            };
        }

        if (mapping.optionAxis !== params.axis || !mapping.optionValue?.trim()) {
            throw new ValidationError("Variant image mappings must use the product's selected option axis.");
        }
        const normalizedOptionValue = normalizeVariantImageOptionValue(mapping.optionValue);
        const canonicalOptionValue = optionValueByKey.get(normalizedOptionValue);
        if (!canonicalOptionValue) {
            throw new ValidationError("A variant image mapping references an option value that is not on this product.");
        }

        return {
            id: params.createId(),
            productId: params.productId,
            imageId,
            variantId: null,
            optionAxis: params.axis,
            optionValue: canonicalOptionValue,
            normalizedOptionValue,
            sortOrder,
        };
    });
}
