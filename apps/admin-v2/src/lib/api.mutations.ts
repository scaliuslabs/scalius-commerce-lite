/**
 * Compatibility barrel for admin mutation hooks.
 *
 * Route-reachable code should import from `~/lib/api-mutations/<domain>` so
 * one page does not pull every mutation domain into its module graph.
 */

export * from "./api-mutations/analytics";
export * from "./api-mutations/attributes";
export * from "./api-mutations/cache";
export * from "./api-mutations/categories";
export * from "./api-mutations/checkout-languages";
export * from "./api-mutations/collections";
export * from "./api-mutations/customers";
export * from "./api-mutations/delivery-locations";
export * from "./api-mutations/discounts";
export * from "./api-mutations/media";
export * from "./api-mutations/orders";
export * from "./api-mutations/pages";
export * from "./api-mutations/products";
export * from "./api-mutations/settings";
export * from "./api-mutations/shipping-methods";
export * from "./api-mutations/widgets";
