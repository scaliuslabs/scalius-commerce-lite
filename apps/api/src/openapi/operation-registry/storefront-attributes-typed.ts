// Agent operation registry rows for slice 1b's storefront reads: product
// comparison (typed specs grouped by attribute group).
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_ATTRIBUTES_TYPED_OPERATIONS = {
  "storefront.products.compare": { limits: { request: 16_384 } },
} satisfies Record<string, OperationRegistryEntry>;
