// src/db/schema/index.ts
// Single barrel re-export for the entire schema.
// This ensures all existing imports like:
//   import { products } from "@/db/schema"
//   import * as schema from "./schema"
// continue to work without modification.

export * from "./shared";
export * from "./enums";
export * from "./auth";
export * from "./rbac";
export * from "./products";
export * from "./catalog";
export * from "./media";
export * from "./markets";
export * from "./customers";
export * from "./customer-marketing";
export * from "./orders";
export * from "./fulfilment";
export * from "./conversations";
export * from "./notifications";
export * from "./inventory";
export * from "./purchasing";
export * from "./delivery";
export * from "./marketing";
export * from "./promotions";
export * from "./content";
export * from "./navigation";
export * from "./system";
export * from "./tax";
export * from "./agent-access";
export * from "./reviews";
export * from "./digital";
export * from "./gift-cards";
export * from "./warranty";
export * from "./events";
export * from "./custom-fields";
export * from "./plugins";
export * from "./price-lists";
export * from "./translations";
export * from "./sales-channels";
export * from "./metaobjects";
export * from "./web-push";
export * from "./customer-identities";
