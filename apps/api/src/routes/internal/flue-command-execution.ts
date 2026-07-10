import type { Context } from "hono";
import { z } from "zod/v4";
import {
  SCALIUS_COMMAND_HELP,
  parseScaliusCommandProgram,
  type ScaliusCommand,
  type ScaliusCommandJsonObject,
} from "@scalius/shared/assistant-command";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import { getDashboardSummaryStats } from "@scalius/core/modules/analytics/dashboard.service";
import * as ProductsAdmin from "@scalius/core/modules/products/products.admin";
import {
  getStorefrontProductBySlug,
  getStorefrontProducts,
  searchStorefrontProducts,
} from "@scalius/core/modules/products/products.storefront";
import { getCurrencySettings } from "@scalius/core/modules/settings/site-settings.service";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

import {
  resolveAdminFlueCommandAuthority,
  resolveStorefrontFlueCommandAuthority,
} from "./flue-command-authority";

export interface FlueCommandSuccess {
  success: true;
  data: ScaliusCommandJsonObject;
}

export interface FlueCommandFailure {
  success: false;
  error: { code: string; message: string; retryable: boolean };
}

export type FlueCommandResponse = FlueCommandSuccess | FlueCommandFailure;

interface CapabilityDescriptor {
  id: string;
  title: string;
  description: string;
  mode: "read";
  arguments: ScaliusCommandJsonObject;
  permission?: string;
}

const ADMIN_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  {
    id: "admin.api.get.dashboard.metrics-summary",
    title: "Dashboard summary",
    description: "Read current aggregate product, customer, order, and revenue metrics.",
    mode: "read",
    arguments: {} as ScaliusCommandJsonObject,
    permission: "dashboard.view",
  },
  {
    id: "admin.api.get.products.stats",
    title: "Product counts",
    description: "Read total, active, imaged-product, and category counts.",
    mode: "read",
    arguments: {} as ScaliusCommandJsonObject,
    permission: "products.view",
  },
  {
    id: "admin.api.get.products",
    title: "Find Admin products",
    description: "Read one bounded page of non-trashed products and authoritative pagination.",
    mode: "read",
    arguments: {
      search: "optional text, max 120",
      page: "optional integer 1..1000",
      limit: "optional integer 1..10",
    } as ScaliusCommandJsonObject,
    permission: "products.view",
  },
  {
    id: "admin.api.get.products.by-id",
    title: "Admin product detail",
    description: "Read one product by its opaque product ID without mutation.",
    mode: "read",
    arguments: { id: "product ID, max 160" } as ScaliusCommandJsonObject,
    permission: "products.view",
  },
]);

const STOREFRONT_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  {
    id: "catalog.search",
    title: "Search products",
    description: "Search buyer-visible products and return compact purchasable results.",
    mode: "read",
    arguments: {
      query: "search text, max 120",
      page: "optional integer 1..20",
      limit: "optional integer 1..8",
    } as ScaliusCommandJsonObject,
  },
  {
    id: "catalog.list",
    title: "Browse products",
    description: "Read one bounded page of buyer-visible products.",
    mode: "read",
    arguments: {
      page: "optional integer 1..20",
      limit: "optional integer 1..8",
      sort: "optional newest, price-asc, price-desc, name-asc, name-desc, or discount",
    } as ScaliusCommandJsonObject,
  },
  {
    id: "catalog.product",
    title: "Product detail",
    description: "Read one buyer-visible product, its available options, and safe media.",
    mode: "read",
    arguments: { slug: "product slug, max 160" } as ScaliusCommandJsonObject,
  },
]);

const adminProductsInput = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  page: z.number().int().min(1).max(1_000).default(1),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();
const idInput = z.object({
  id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
}).strict();
const emptyInput = z.object({}).strict();
const catalogSearchInput = z.object({
  query: z.string().trim().min(1).max(120),
  page: z.number().int().min(1).max(20).default(1),
  limit: z.number().int().min(1).max(8).default(5),
}).strict();
const catalogListInput = z.object({
  page: z.number().int().min(1).max(20).default(1),
  limit: z.number().int().min(1).max(8).default(5),
  sort: z.enum([
    "newest",
    "price-asc",
    "price-desc",
    "name-asc",
    "name-desc",
    "discount",
  ]).default("newest"),
}).strict();
const slugInput = z.object({
  slug: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
}).strict();

export async function executeAdminFlueCommand(
  c: Context<{ Bindings: Env }>,
  input: { instanceId: string; program: string },
): Promise<FlueCommandResponse> {
  const parsed = parseScaliusCommandProgram(input.program);
  if (!parsed.ok) return invalidCommand(parsed.error.message);
  const authority = await resolveAdminFlueCommandAuthority(c, input.instanceId);
  return executeCommand({
    c,
    command: parsed.command,
    capabilities: ADMIN_CAPABILITIES.filter(
      (capability) => !capability.permission || authority.permissions.has(capability.permission),
    ),
    call: (command) => callAdminCapability(c, command, authority.permissions),
  });
}

export async function executeStorefrontFlueCommand(
  c: Context<{ Bindings: Env }>,
  input: { instanceId: string; program: string },
): Promise<FlueCommandResponse> {
  const parsed = parseScaliusCommandProgram(input.program);
  if (!parsed.ok) return invalidCommand(parsed.error.message);
  await resolveStorefrontFlueCommandAuthority(c, input.instanceId);
  return executeCommand({
    c,
    command: parsed.command,
    capabilities: STOREFRONT_CAPABILITIES,
    call: (command) => callStorefrontCapability(c, command),
  });
}

async function executeCommand(input: {
  c: Context<{ Bindings: Env }>;
  command: ScaliusCommand;
  capabilities: readonly CapabilityDescriptor[];
  call: (command: Extract<ScaliusCommand, { name: "call" }>) => Promise<ScaliusCommandJsonObject>;
}): Promise<FlueCommandResponse> {
  const { command, capabilities } = input;
  if (command.name === "help") {
    return success({
      command: "help",
      usage: SCALIUS_COMMAND_HELP.split("\n"),
      guidance: "Discover one capability, call reads, and use computer for visible page interaction. Mutations remain merchant-confirmed.",
      capabilities: capabilities.map(compactCapability),
    });
  }
  if (command.name === "find") {
    const terms = command.terms.toLowerCase().split(" ").filter(Boolean);
    const matches = capabilities.filter((capability) => {
      const haystack = `${capability.id} ${capability.title} ${capability.description}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }).slice(0, 12);
    return success({ command: "find", capabilities: matches.map(compactCapability) });
  }
  if (command.name === "show") {
    const capability = capabilities.find((candidate) => candidate.id === command.capabilityId);
    if (!capability) return failure("capability_not_found", "That capability is not available.", false);
    return success({ command: "show", capability: compactCapability(capability) });
  }
  if (command.name === "call") {
    const capability = capabilities.find((candidate) => candidate.id === command.capabilityId);
    if (!capability) return failure("capability_not_found", "That capability is not available.", false);
    return success({
      command: "call",
      capability: { id: capability.id, title: capability.title },
      result: await input.call(command),
    });
  }
  if (command.name === "prepare") {
    return failure(
      "mutation_not_ready",
      "This mutation has no verified preview and confirmation adapter yet. Use the visible Admin controls.",
      false,
    );
  }
  if (command.name === "status") {
    return failure("status_not_found", "No accessible workflow was found.", false);
  }
  return failure("cancellation_not_available", "No cancellable workflow was found.", false);
}

async function callAdminCapability(
  c: Context<{ Bindings: Env }>,
  command: Extract<ScaliusCommand, { name: "call" }>,
  permissions: ReadonlySet<string>,
): Promise<ScaliusCommandJsonObject> {
  const db = c.get("db");
  const requirePermission = (permission: string) => {
    if (!permissions.has(permission)) throw new NotFoundError("Capability not found.");
  };
  switch (command.capabilityId) {
    case "admin.api.get.dashboard.metrics-summary": {
      requirePermission("dashboard.view");
      parseArguments(emptyInput, command.arguments);
      const [stats, currency] = await Promise.all([
        getDashboardSummaryStats(db),
        getCurrencySettings(db),
      ]);
      return {
        currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        stats: stats as unknown as ScaliusCommandJsonObject,
      };
    }
    case "admin.api.get.products.stats": {
      requirePermission("products.view");
      parseArguments(emptyInput, command.arguments);
      return { stats: await ProductsAdmin.getProductStats(db) };
    }
    case "admin.api.get.products": {
      requirePermission("products.view");
      const args = parseArguments(adminProductsInput, command.arguments);
      const [result, currency] = await Promise.all([
        ProductsAdmin.listProducts(db, {
          search: args.search,
          page: args.page,
          limit: args.limit,
          showTrashed: false,
          sort: "updatedAt",
          order: "desc",
        }),
        getCurrencySettings(db),
      ]);
      return {
        currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        products: result.products.slice(0, args.limit).map((product) => ({
          id: product.id,
          name: compactText(product.name, 180),
          slug: product.slug,
          route: `/admin/products/${product.id}`,
          active: Boolean(product.isActive),
          category: compactText(product.category?.name, 120),
          price: finiteNumber(product.price),
          variantCount: finiteNumber(product.variantCount),
          imageCount: finiteNumber(product.imageCount),
          imageUrl: safeHttpUrl(product.primaryImage),
          updatedAt: validDate(product.updatedAt),
        })),
        pagination: result.pagination,
      };
    }
    case "admin.api.get.products.by-id": {
      requirePermission("products.view");
      const args = parseArguments(idInput, command.arguments);
      const [result, currency] = await Promise.all([
        ProductsAdmin.getProductDetails(db, args.id),
        getCurrencySettings(db),
      ]);
      const record = asRecord(result);
      return {
        currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        product: {
          id: stringValue(record.id),
          name: compactText(record.name, 180),
          slug: stringValue(record.slug),
          route: `/admin/products/${args.id}`,
          active: Boolean(record.isActive),
          price: finiteNumber(record.price),
          category: compactText(asRecord(record.category).name, 120),
          variantCount: Array.isArray(record.variants) ? record.variants.length : 0,
          imageCount: Array.isArray(record.images) ? record.images.length : 0,
        },
      };
    }
    default:
      throw new NotFoundError("Capability not found.");
  }
}

async function callStorefrontCapability(
  c: Context<{ Bindings: Env }>,
  command: Extract<ScaliusCommand, { name: "call" }>,
): Promise<ScaliusCommandJsonObject> {
  const db = c.get("db");
  switch (command.capabilityId) {
    case "catalog.search": {
      const args = parseArguments(catalogSearchInput, command.arguments);
      const [result, currency] = await Promise.all([
        searchStorefrontProducts(db, {
          search: args.query,
          page: args.page,
          limit: args.limit,
        }),
        getCurrencySettings(db),
      ]);
      return {
        currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        products: result.data.slice(0, args.limit).map((product) => ({
          id: product.id,
          name: compactText(product.name, 180),
          slug: product.slug,
          route: `/products/${product.slug}`,
          price: finiteNumber(product.price),
          currentPrice: finiteNumber(calculateDiscountedPrice(
            product.price,
            product.discountType,
            product.discountPercentage,
            product.discountAmount,
          )),
          imageUrl: safeHttpUrl(product.imageUrl),
          availableForSale: Array.isArray(product.variants) &&
            product.variants.some(variantAvailableForSale),
        })),
        pagination: result.pagination,
      };
    }
    case "catalog.list": {
      const args = parseArguments(catalogListInput, command.arguments);
      const [result, currency] = await Promise.all([
        getStorefrontProducts(db, {
          page: args.page,
          limit: args.limit,
          sort: args.sort,
        }),
        getCurrencySettings(db),
      ]);
      return {
        currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        products: result.products.slice(0, args.limit).map((product) => ({
          id: product.id,
          name: compactText(product.name, 180),
          slug: product.slug,
          route: `/products/${product.slug}`,
          price: finiteNumber(product.price),
          currentPrice: finiteNumber(product.discountedPrice),
          imageUrl: safeHttpUrl(product.imageUrl),
          availableForSale: Boolean(product.availableForSale),
        })),
        pagination: result.pagination,
      };
    }
    case "catalog.product": {
      const args = parseArguments(slugInput, command.arguments);
      const [result, currency] = await Promise.all([
        getStorefrontProductBySlug(db, args.slug),
        getCurrencySettings(db),
      ]);
      if (!result) throw new NotFoundError("Product not found.");
      const product = asRecord(result.product);
      const option1Label = compactText(product.variantOption1Label, 80);
      const option2Label = compactText(product.variantOption2Label, 80);
      const variants = Array.isArray(result.variants) ? result.variants : [];
      const availableForSale = variants.some(variantAvailableForSale);
      return {
        currency: { code: currency.currencyCode, symbol: currency.currencySymbol },
        product: {
          id: stringValue(product.id),
          name: compactText(product.name, 180),
          slug: stringValue(product.slug),
          route: `/products/${args.slug}`,
          price: finiteNumber(product.price),
          currentPrice: finiteNumber(product.discountedPrice),
          freeDelivery: Boolean(product.freeDelivery),
          availableForSale,
          category: compactText(asRecord(result.category).name, 120),
          images: (Array.isArray(result.images) ? result.images : []).slice(0, 6)
            .map((image) => ({
              url: safeHttpUrl(asRecord(image).url),
              alt: compactText(asRecord(image).alt, 180),
            })).filter((image) => image.url !== null),
          options: variants.slice(0, 40).map((variantValue) => {
            const variant = asRecord(variantValue);
            const tracked = Boolean(variant.trackInventory);
            const stock = finiteNumber(variant.stock) ?? 0;
            const reserved = finiteNumber(variant.reservedStock) ?? 0;
            return {
              id: stringValue(variant.id),
              values: [
                option1Label && compactText(variant.size, 100)
                  ? { name: option1Label, value: compactText(variant.size, 100) }
                  : null,
                option2Label && compactText(variant.color, 100)
                  ? { name: option2Label, value: compactText(variant.color, 100) }
                  : null,
              ].filter((value) => value !== null),
              price: finiteNumber(variant.price),
              currentPrice: finiteNumber(calculateDiscountedPrice(
                finiteNumber(variant.price) ?? finiteNumber(product.price) ?? 0,
                stringValue(variant.discountType),
                finiteNumber(variant.discountPercentage),
                finiteNumber(variant.discountAmount),
              )),
              availableForSale: !tracked || stock - reserved > 0,
            };
          }),
        },
      };
    }
    default:
      throw new NotFoundError("Capability not found.");
  }
}

function compactCapability(capability: CapabilityDescriptor): ScaliusCommandJsonObject {
  return {
    id: capability.id,
    title: capability.title,
    description: capability.description,
    mode: capability.mode,
    arguments: capability.arguments,
  };
}

function parseArguments<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Capability arguments are invalid.");
  return parsed.data;
}

function success(data: ScaliusCommandJsonObject): FlueCommandSuccess {
  return { success: true, data };
}

export function failure(
  code: string,
  message: string,
  retryable: boolean,
): FlueCommandFailure {
  return { success: false, error: { code, message, retryable } };
}

function invalidCommand(message: string): FlueCommandFailure {
  return failure("invalid_program", message, false);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 180) : null;
}

function compactText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function validDate(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
}

function variantAvailableForSale(value: unknown): boolean {
  const variant = asRecord(value);
  if (!variant.trackInventory) return true;
  const stock = finiteNumber(variant.stock) ?? 0;
  const reserved = finiteNumber(variant.reservedStock) ?? 0;
  return stock - reserved > 0;
}
