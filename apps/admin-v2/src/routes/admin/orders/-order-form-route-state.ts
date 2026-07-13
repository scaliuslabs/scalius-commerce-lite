import type { Product } from "~/components/admin/order-form/types";
import type { ProductVariant } from "~/types/api-responses";

interface ProductListRow {
  id: string;
  name: string;
  price: number;
  discountPercentage?: number | null;
  discountType?: "percentage" | "flat" | null;
  discountAmount?: number | null;
  variantCount?: number | null;
}

export interface EditOrderFormProduct {
  id: string;
  name: string;
  price: number;
  discountPercentage: number | null;
  variants: ProductVariant[];
}

export interface EditOrderFormRouteData {
  productsWithVariants: EditOrderFormProduct[];
  defaultValues: Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response was unavailable or unusable.`);
  }
  return value as Record<string, unknown>;
}

function isProductListRow(value: unknown): value is ProductListRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.name === "string" &&
    typeof row.price === "number" &&
    Number.isFinite(row.price)
  );
}

function isEditOrderFormProduct(value: unknown): value is EditOrderFormProduct {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.name === "string" &&
    typeof row.price === "number" &&
    Number.isFinite(row.price) &&
    Array.isArray(row.variants)
  );
}

function normalizeEditOrderFormProduct(
  value: EditOrderFormProduct,
): EditOrderFormProduct {
  return {
    ...value,
    variants: value.variants.map((variant) => {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
        throw new Error("Order form response included an unusable SKU row.");
      }
      const selectedOptions = (variant as ProductVariant & {
        selectedOptions?: unknown;
      }).selectedOptions;
      if (selectedOptions !== undefined && !Array.isArray(selectedOptions)) {
        throw new Error("Order form response included unusable SKU options.");
      }
      return {
        ...variant,
        // Rolling deploys and cached responses may predate the required
        // form-data contract. A missing collection means the SKU has no
        // customer-facing axes (for example a default/simple SKU), not that
        // the required catalog or order-item dependency can be invented.
        selectedOptions: selectedOptions ?? [],
      };
    }),
  };
}

export function buildNewOrderFormRouteData(payload: unknown): {
  productsWithVariants: Product[];
} {
  const data = requireRecord(payload, "Product catalog");
  if (!Array.isArray(data.products)) {
    throw new Error("Product catalog response did not include a product list.");
  }
  if (!data.products.every(isProductListRow)) {
    throw new Error("Product catalog response included an unusable product row.");
  }

  return {
    productsWithVariants: data.products.map((product) => ({
      id: product.id,
      name: product.name,
      price: product.price,
      discountPercentage: product.discountPercentage ?? null,
      discountType: product.discountType ?? null,
      discountAmount: product.discountAmount ?? null,
      variantCount: product.variantCount ?? 0,
      variants: [],
    })),
  };
}

export function assertOrderFormLocationLookup(payload: unknown): void {
  const data = requireRecord(payload, "Delivery location");
  if (!Array.isArray(data.locations)) {
    throw new Error("Delivery location response did not include a location list.");
  }
}

export function buildEditOrderFormRouteData(payload: unknown): EditOrderFormRouteData {
  const data = requireRecord(payload, "Order form");
  if (!Array.isArray(data.productsWithVariants)) {
    throw new Error("Order form response did not include the product catalog.");
  }
  if (!data.productsWithVariants.every(isEditOrderFormProduct)) {
    throw new Error("Order form response included an unusable product row.");
  }
  const defaultValues = requireRecord(data.defaultValues, "Order form defaults");
  if (!Array.isArray(defaultValues.items)) {
    throw new Error("Order form defaults did not include order items.");
  }
  return {
    productsWithVariants: data.productsWithVariants.map(
      normalizeEditOrderFormProduct,
    ),
    defaultValues,
  };
}
