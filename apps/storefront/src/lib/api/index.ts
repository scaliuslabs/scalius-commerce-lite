// src/lib/api/index.ts

/**
 * Barrel file for the Scalius Commerce API client library.
 * This file re-exports all the functions from the individual resource modules,
 * providing a single, clean entry point for the rest of the application.
 *
 * Example Usage:
 * import { getProductBySlug, getAllCategories } from '@/lib/api';
 */

// Core client (if needed elsewhere, though typically not directly used)
export * from "./client";

// Resource-specific functions
export * from "./products";
export * from "./categories";
export * from "./collections";
export * from "./header";
export * from "./footer";
export * from "./navigation";
export * from "./pages";
export * from "./search";
export * from "./orders";
export * from "./discounts";
export * from "./shipping";
export * from "./widgets";
export * from "./settings";
export * from "./attributes";
export * from "./tracking";
export * from "./abandoned-checkouts";

export * from "./storefront";
export * from "./types";

export * from "./customer-auth";
export * from "./checkout";
export * from "./payment";
