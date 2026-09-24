// Products domain: the merchant-edited product aggregate — products, SKUs
// (variants), options, media, validation and the aggregate revision — plus the
// product rules other domains read through: public eligibility, buyer
// pricing and money. Buyer-facing catalogue reads live in modules/catalog.
export * from "./types";
export * from "./admin/write";
export * from "./admin/read";
export * from "./admin/lifecycle";
export * from "./variants";
export * from "./option-model";
export * from "./option-matrix";
export * from "./validation";
export * from "./media";
export * from "./semantic-sections";
export * from "./money";
export * from "./public-eligibility";
export * from "./buyer-projection";
export * from "./variant-identity";
export * from "./aggregate-revision";
