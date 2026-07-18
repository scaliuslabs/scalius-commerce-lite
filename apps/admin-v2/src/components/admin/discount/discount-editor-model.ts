import { formatPrice } from "@scalius/shared/currency";
import { z } from "zod";

import {
  discountCodeSchema,
  normalizeDiscountEndDate,
  normalizeDiscountStartDate,
} from "./shared-validation";
import { formatDiscountRequirement } from "./discount-rule-presentation";

export const discountEditorTypes = [
  "amount_off_products",
  "amount_off_order",
  "free_shipping",
] as const;

export type DiscountEditorType = (typeof discountEditorTypes)[number];
export type DiscountEditorValueType = "percentage" | "fixed_amount" | "free";

const optionalPositiveAmount = z
  .number({ message: "Enter a valid amount" })
  .finite()
  .positive("Amount must be greater than zero")
  .nullable();

const optionalPositiveInteger = z
  .number({ message: "Enter a whole number" })
  .int("Enter a whole number")
  .positive("Value must be greater than zero")
  .nullable();

export const discountEditorSchema = z
  .object({
    type: z.enum(discountEditorTypes),
    code: discountCodeSchema,
    valueType: z.enum(["percentage", "fixed_amount", "free"]),
    discountValue: z.number().finite().positive("Value must be greater than zero"),
    appliesTo: z.object({
      products: z.array(z.string().trim().min(1)).max(90),
      collections: z.array(z.string().trim().min(1)).max(90),
    }),
    minPurchaseAmount: optionalPositiveAmount,
    minQuantity: optionalPositiveInteger,
    maxUses: optionalPositiveInteger,
    limitOnePerCustomer: z.boolean(),
    startDate: z.date({ message: "Choose a start date" }),
    endDate: z.date().nullable(),
    isActive: z.boolean(),
  })
  .superRefine((values, context) => {
    if (values.type === "free_shipping") {
      if (values.valueType !== "free") {
        context.addIssue({
          code: "custom",
          path: ["valueType"],
          message: "Free shipping must use the free-shipping value",
        });
      }
    } else if (values.valueType === "free") {
      context.addIssue({
        code: "custom",
        path: ["valueType"],
        message: "Choose percentage or fixed amount",
      });
    }

    if (values.valueType === "percentage" && values.discountValue > 100) {
      context.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "Percentage cannot exceed 100%",
      });
    }

    const scopeCount =
      values.appliesTo.products.length + values.appliesTo.collections.length;
    if (scopeCount > 90) {
      context.addIssue({
        code: "custom",
        path: ["appliesTo"],
        message: "Choose at most 90 products and collections in total",
      });
    }
    if (values.type === "amount_off_products" && scopeCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["appliesTo"],
        message: "Choose at least one product or collection",
      });
    }

    if (
      values.endDate &&
      normalizeDiscountEndDate(values.endDate) <=
        normalizeDiscountStartDate(values.startDate)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date must be on or after the start date",
      });
    }
  });

export type DiscountEditorValues = z.infer<typeof discountEditorSchema>;

export interface DiscountEditorDefaults {
  code?: string;
  valueType?: DiscountEditorValueType | string;
  discountValue?: number;
  minPurchaseAmount?: number | null;
  minQuantity?: number | null;
  maxUses?: number | null;
  limitOnePerCustomer?: boolean;
  startDate?: Date | string | number | null;
  endDate?: Date | string | number | null;
  isActive?: boolean;
  appliesToProducts?: string[];
  appliesToCollections?: string[];
  maxUsesPerOrder?: number | null;
  combineWithProductDiscounts?: boolean;
  combineWithOrderDiscounts?: boolean;
  combineWithShippingDiscounts?: boolean;
  customerSegment?: string | null;
}

export function needsDiscountWriteNormalization(
  type: DiscountEditorType,
  defaults: DiscountEditorDefaults,
): boolean {
  const normalizedValueType =
    type === "free_shipping"
      ? "free"
      : defaults.valueType === "fixed_amount"
        ? "fixed_amount"
        : "percentage";
  const savedDiscountValue = Number(defaults.discountValue);
  const hasIgnoredScope =
    type !== "amount_off_products" &&
    ((defaults.appliesToProducts?.length ?? 0) > 0 ||
      (defaults.appliesToCollections?.length ?? 0) > 0);

  return (
    defaults.valueType !== normalizedValueType ||
    (type === "free_shipping" && savedDiscountValue !== 1) ||
    (defaults.maxUsesPerOrder !== null &&
      defaults.maxUsesPerOrder !== undefined &&
      defaults.maxUsesPerOrder !== 1) ||
    Boolean(defaults.combineWithProductDiscounts) ||
    Boolean(defaults.combineWithOrderDiscounts) ||
    Boolean(defaults.combineWithShippingDiscounts) ||
    Boolean(defaults.customerSegment?.trim()) ||
    hasIgnoredScope
  );
}

export function hydrateSelectedOptionLabels<T extends { id: string; name: string }>(
  current: T[],
  resolved: T[],
): T[] {
  const resolvedById = new Map(resolved.map((item) => [item.id, item]));
  let changed = false;
  const hydrated = current.map((item) => {
    const replacement = resolvedById.get(item.id);
    if (
      replacement &&
      replacement.name &&
      replacement.name !== replacement.id &&
      (!item.name || item.name === item.id)
    ) {
      changed = true;
      return { ...item, ...replacement };
    }
    return item;
  });

  return changed ? hydrated : current;
}

function validDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function createDiscountEditorDefaults(
  type: DiscountEditorType,
  defaults: DiscountEditorDefaults = {},
): DiscountEditorValues {
  const valueType =
    type === "free_shipping"
      ? "free"
      : defaults.valueType === "fixed_amount"
        ? "fixed_amount"
        : "percentage";

  return {
    type,
    code: defaults.code ?? "",
    valueType,
    discountValue:
      type === "free_shipping" ? 1 : Number(defaults.discountValue ?? 10),
    appliesTo: {
      products: Array.from(new Set(defaults.appliesToProducts ?? [])),
      collections: Array.from(new Set(defaults.appliesToCollections ?? [])),
    },
    minPurchaseAmount:
      defaults.minPurchaseAmount == null
        ? null
        : Number(defaults.minPurchaseAmount),
    minQuantity:
      defaults.minQuantity == null ? null : Number(defaults.minQuantity),
    maxUses: defaults.maxUses == null ? null : Number(defaults.maxUses),
    limitOnePerCustomer: Boolean(defaults.limitOnePerCustomer),
    startDate: validDate(defaults.startDate) ?? new Date(),
    endDate: validDate(defaults.endDate),
    isActive: Boolean(defaults.isActive),
  };
}

export function parseOptionalNumber(value: string, integer = false): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    return Number.NaN;
  }
  return parsed;
}

export function toDateInputValue(value: Date | null): string {
  if (!value || !Number.isFinite(value.getTime())) return "";
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fromDateInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isFinite(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

export function getDiscountTypeLabel(type: DiscountEditorType): string {
  switch (type) {
    case "amount_off_products":
      return "Amount off products";
    case "amount_off_order":
      return "Amount off order";
    case "free_shipping":
      return "Free shipping";
  }
}

export function buildDiscountRuleSummary(
  values: DiscountEditorValues,
  symbol: string,
): string {
  if (values.type === "free_shipping") {
    return "Free delivery for eligible orders.";
  }

  const outcome =
    values.valueType === "percentage"
      ? `${values.discountValue || 0}% off`
      : `${formatPrice(values.discountValue || 0, { symbol })} off`;

  const target =
    values.type === "amount_off_order"
      ? "the merchandise subtotal"
      : [
          values.appliesTo.products.length
            ? `${values.appliesTo.products.length} ${
                values.appliesTo.products.length === 1 ? "product" : "products"
              }`
            : null,
          values.appliesTo.collections.length
            ? `${values.appliesTo.collections.length} ${
                values.appliesTo.collections.length === 1
                  ? "collection"
                  : "collections"
              }`
            : null,
      ]
        .filter(Boolean)
        .join(" and ") || "selected merchandise";

  return `${outcome} ${target}.`;
}

export function buildDiscountRequirementSummary(
  values: DiscountEditorValues,
  symbol: string,
): string {
  return formatDiscountRequirement({
    minPurchaseAmount: values.minPurchaseAmount,
    minQuantity: values.minQuantity,
    symbol,
  });
}

export function toDiscountWritePayload(values: DiscountEditorValues) {
  const parsed = discountEditorSchema.parse(values);
  return {
    code: parsed.code,
    type: parsed.type,
    valueType: parsed.valueType,
    discountValue: parsed.type === "free_shipping" ? 1 : parsed.discountValue,
    minPurchaseAmount: parsed.minPurchaseAmount,
    minQuantity: parsed.minQuantity,
    maxUsesPerOrder: 1,
    maxUses: parsed.maxUses,
    limitOnePerCustomer: parsed.limitOnePerCustomer,
    combineWithProductDiscounts: false,
    combineWithOrderDiscounts: false,
    combineWithShippingDiscounts: false,
    customerSegment: null,
    startDate: normalizeDiscountStartDate(parsed.startDate),
    endDate: parsed.endDate ? normalizeDiscountEndDate(parsed.endDate) : null,
    isActive: parsed.isActive,
    appliesToProducts:
      parsed.type === "amount_off_products" ? parsed.appliesTo.products : [],
    appliesToCollections:
      parsed.type === "amount_off_products" ? parsed.appliesTo.collections : [],
  };
}
