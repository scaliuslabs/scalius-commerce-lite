// Products domain: what a product and its SKUs are, and the product rules
// other domains read through — public eligibility, buyer pricing and money,
// media projections, options, the SKU alert level and availability band,
// customization, content blocks, bundles, EMI, the digital and gift-card
// stock rules — plus the catalogue projections that cache them. The
// dashboard's product editor (writes, admin reads, the aggregate revision)
// lives in modules/product-admin; buyer-facing catalogue reads live in
// modules/catalog.
export * from "./types";
export * from "./option-model";
export * from "./media";
export * from "./money";
export * from "./public-eligibility";
export * from "./channel-publications";
export * from "./buyer-projection";
export * from "./variant-identity";
export * from "./customization";
export * from "./catalog-projections";
export * from "./low-stock-policy";
export * from "./content-blocks";
export * from "./bundles";
export * from "./emi";
export * from "./digital-stock-rules";
export * from "./gift-card-rules";
