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
export * from "./customers";
export * from "./orders";
export * from "./inventory";
export * from "./delivery";
export * from "./marketing";
export * from "./content";
export * from "./system";
export * from "./assistant";
