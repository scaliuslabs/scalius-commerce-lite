// What staff call each record an approval names: one bounded reader per kind
// (`APPROVAL_RECORD_KINDS`), by id, in chunks well inside D1's bound-parameter
// limit. A name is whatever was stored (an agent can rename a product), so it
// is cleaned, bounded and shown beside its id; a record with no name (gone, or
// not of that kind) has none, and the change cannot be approved
// (approvals.ts unnamedRecordReasons).
import { eq, inArray } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "@scalius/database/client";
import {
  agentGrants, analytics, attributeGroups, mediaFolders, orderReturns, urlRedirects, brands, categories, checkoutLanguages, collections, customFieldDefinitions, customerPaymentMethods,
  customerSegments, customers, deliveryProviders, deliveryZones, digitalAssets, giftCards, inventoryLocations, inventoryTransfers,
  markets, media, navigationMenus, orderItems, orderPayments, orders, pages, paymentDisputes, permissions, places, pluginInstallations,
  priceLists, productAttributes, productVariants, products, promotions, purchaseOrders, rolePermissions, roles, salesChannels,
  shippingMethods, shippingProfiles, suppliers, taxClasses, taxRates, taxRegions, user, warrantyPolicies, webhookSubscriptions,
} from "@scalius/database/schema";
import { cleanAgentLabel } from "@scalius/shared/agent-label";
import type { ApprovalRecordKind } from "@scalius/shared/agent-approval";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { cleanSummaryText } from "./summary-rows";
import { BUILT_IN_ROLE_NAMES, builtInRoleKey, type BuiltInRoleKey } from "@scalius/shared/built-in-roles";

/** One record the change acts on: its stored name (untrusted text); a payment or chargeback also its amount; a role what it may do. */
export interface AgentApprovalRecord {
  id: string;
  name: string | null;
  /** A payment's or chargeback's amount in major units, with its currency (the page formats it). */
  amount?: string;
  currency?: string;
  /** A role: the permissions it grants (the page words them). */
  permissions?: string[];
  /** A built-in role: its key, so the page names it in the dashboard's language as the role picker does. */
  builtInRole?: BuiltInRoleKey;
}

interface Found {
  id: string;
  name: string | null;
  builtInRole?: BuiltInRoleKey;
  amountMinor?: number | null;
  currency?: string | null;
}

/** Ids per read: D1 binds at most 100 parameters to a statement. */
const CHUNK = 90;

type Reader = (db: Database, ids: string[]) => Promise<Found[]>;

/** A reader that selects an id and a name column from one table. */
const named = (table: SQLiteTable, id: SQLiteColumn, name: SQLiteColumn): Reader =>
  async (db, ids) => (await db.select({ id, name }).from(table).where(inArray(id, ids))) as Found[];

const READERS: Readonly<Record<ApprovalRecordKind, Reader>> = {
  product: named(products, products.id, products.name),
  variant: async (db, ids) => (await db.select({ id: productVariants.id, sku: productVariants.sku, productName: products.name })
    .from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, ids))).map((row) => ({ id: row.id, name: `${row.productName} (${row.sku})` })),
  order: async (db, ids) => (await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.id, ids)))
    .map((row) => ({ id: row.id, name: formatOrderNumber(row.orderNumber, row.id) })),
  order_item: async (db, ids) => (await db.select({ id: orderItems.id, productName: orderItems.productName, sku: orderItems.sku })
    .from(orderItems).where(inArray(orderItems.id, ids)))
    .map((row) => ({ id: row.id, name: row.productName ? `${row.productName}${row.sku ? ` (${row.sku})` : ""}` : row.sku })),
  customer: named(customers, customers.id, customers.name),
  saved_payment_method: async (db, ids) => (await db.select({
    id: customerPaymentMethods.id, brand: customerPaymentMethods.brand, last4: customerPaymentMethods.last4, label: customerPaymentMethods.label,
  }).from(customerPaymentMethods).where(inArray(customerPaymentMethods.id, ids)))
    .map((row) => ({ id: row.id, name: [row.label, row.brand, row.last4 ? `•••• ${row.last4}` : null].filter(Boolean).join(" ") || null })),
  // Staff know a discount by its name (a code discount's name is its first code).
  discount: named(promotions, promotions.id, promotions.name),
  category: named(categories, categories.id, categories.name),
  collection: named(collections, collections.id, collections.name),
  brand: named(brands, brands.id, brands.name),
  page: named(pages, pages.id, pages.title),
  menu: named(navigationMenus, navigationMenus.id, navigationMenus.name),
  staff: named(user, user.id, user.name),
  // A built-in role by its name in the one catalog the role picker reads; a custom one as typed.
  role: async (db, ids) => (await db.select({ id: roles.id, key: roles.name, name: roles.displayName }).from(roles).where(inArray(roles.id, ids)))
    .map((row) => {
      const key = builtInRoleKey(row.key);
      return key ? { id: row.id, name: BUILT_IN_ROLE_NAMES.en[key], builtInRole: key } : { id: row.id, name: row.name };
    }),
  // Staff know a payment and a chargeback by how much and how it was paid.
  payment: (db, ids) => db.select({ id: orderPayments.id, name: orderPayments.paymentMethod, amountMinor: orderPayments.amountMinor, currency: orderPayments.currency })
    .from(orderPayments).where(inArray(orderPayments.id, ids)),
  dispute: (db, ids) => db.select({ id: paymentDisputes.id, name: paymentDisputes.gateway, amountMinor: paymentDisputes.amountMinor, currency: paymentDisputes.currency })
    .from(paymentDisputes).where(inArray(paymentDisputes.id, ids)),
  delivery_zone: named(deliveryZones, deliveryZones.id, deliveryZones.name),
  shipping_method: named(shippingMethods, shippingMethods.id, shippingMethods.name),
  shipping_profile: named(shippingProfiles, shippingProfiles.id, shippingProfiles.name),
  place: named(places, places.id, places.name),
  market: named(markets, markets.id, markets.name),
  location: named(inventoryLocations, inventoryLocations.id, inventoryLocations.name),
  sales_channel: named(salesChannels, salesChannels.id, salesChannels.name),
  price_list: named(priceLists, priceLists.id, priceLists.name),
  segment: named(customerSegments, customerSegments.id, customerSegments.name),
  tax_class: named(taxClasses, taxClasses.id, taxClasses.name),
  tax_region: async (db, ids) => (await db.select({ id: taxRegions.id, country: taxRegions.countryCode, area: taxRegions.adminArea, postal: taxRegions.postalPrefix })
    .from(taxRegions).where(inArray(taxRegions.id, ids)))
    .map((row) => ({ id: row.id, name: [row.country, row.area, row.postal ? `${row.postal}…` : ""].filter(Boolean).join(" ") })),
  tax_rate: named(taxRates, taxRates.id, taxRates.name),
  webhook: named(webhookSubscriptions, webhookSubscriptions.id, webhookSubscriptions.url),
  gift_card: async (db, ids) => (await db.select({ id: giftCards.id, last4: giftCards.codeLast4 }).from(giftCards).where(inArray(giftCards.id, ids)))
    .map((row) => ({ id: row.id, name: `•••• ${row.last4}` })),
  warranty_policy: named(warrantyPolicies, warrantyPolicies.id, warrantyPolicies.name),
  app: async (db, ids) => (await db.select({ id: pluginInstallations.pluginId, manifest: pluginInstallations.manifestJson })
    .from(pluginInstallations).where(inArray(pluginInstallations.pluginId, ids)))
    .map((row) => ({ id: row.id, name: manifestName(row.manifest) ?? row.id })),
  agent_connection: async (db, ids) => (await db.select({ id: agentGrants.id, label: agentGrants.label }).from(agentGrants).where(inArray(agentGrants.id, ids)))
    .map((row) => ({ id: row.id, name: cleanAgentLabel(row.label) || null })),
  supplier: named(suppliers, suppliers.id, suppliers.name),
  purchase_order: async (db, ids) => (await db.select({ id: purchaseOrders.id, number: purchaseOrders.number }).from(purchaseOrders).where(inArray(purchaseOrders.id, ids)))
    .map((row) => ({ id: row.id, name: `#${row.number}` })),
  transfer: async (db, ids) => (await db.select({ id: inventoryTransfers.id, number: inventoryTransfers.number }).from(inventoryTransfers).where(inArray(inventoryTransfers.id, ids)))
    .map((row) => ({ id: row.id, name: `#${row.number}` })),
  media: named(media, media.id, media.filename),
  analytics_tag: named(analytics, analytics.id, analytics.name),
  checkout_language: named(checkoutLanguages, checkoutLanguages.id, checkoutLanguages.name),
  custom_field: named(customFieldDefinitions, customFieldDefinitions.id, customFieldDefinitions.name),
  digital_asset: named(digitalAssets, digitalAssets.id, digitalAssets.displayName),
  delivery_provider: named(deliveryProviders, deliveryProviders.id, deliveryProviders.name),
  attribute: named(productAttributes, productAttributes.id, productAttributes.name),
  attribute_group: named(attributeGroups, attributeGroups.id, attributeGroups.name),
  media_folder: named(mediaFolders, mediaFolders.id, mediaFolders.name),
  url_redirect: async (db, ids) => (await db.select({ id: urlRedirects.id, from: urlRedirects.fromPath, to: urlRedirects.toPath })
    .from(urlRedirects).where(inArray(urlRedirects.id, ids)))
    .map((row) => ({ id: row.id, name: `${row.from} → ${row.to}` })),
  // A return is known by the order it belongs to.
  order_return: async (db, ids) => (await db.select({ id: orderReturns.id, orderId: orders.id, orderNumber: orders.orderNumber })
    .from(orderReturns).innerJoin(orders, eq(orders.id, orderReturns.orderId)).where(inArray(orderReturns.id, ids)))
    .map((row) => ({ id: row.id, name: formatOrderNumber(row.orderNumber, row.orderId) })),
};

function manifestName(json: string): string | null {
  try {
    const name = (JSON.parse(json) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name : null;
  } catch {
    return null;
  }
}

function safeDecimalPlaces(code: string): number {
  try {
    return getDecimalPlaces(code);
  } catch {
    return 2;
  }
}

/** The permissions each role grants, by role id. */
async function rolePermissionNames(db: Database, ids: string[]): Promise<Map<string, string[]>> {
  const rows = await db.select({ roleId: rolePermissions.roleId, name: permissions.name })
    .from(rolePermissions).innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(inArray(rolePermissions.roleId, ids));
  const byRole = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const row of rows) byRole.get(row.roleId)?.push(row.name);
  return byRole;
}

/** The records of one kind, in the order of `ids`, each with its name (null when there is none). */
export async function readApprovalRecords(db: Database, kind: ApprovalRecordKind, ids: readonly string[]): Promise<AgentApprovalRecord[]> {
  const unique = [...new Set(ids)];
  const found = new Map<string, Found>();
  for (let start = 0; start < unique.length; start += CHUNK) {
    for (const row of await READERS[kind](db, unique.slice(start, start + CHUNK))) found.set(row.id, row);
  }
  const roles = kind === "role" && unique.length > 0 ? await rolePermissionNames(db, unique.slice(0, CHUNK)) : null;
  return unique.map((id) => {
    const row = found.get(id);
    const money = row && typeof row.amountMinor === "number" && row.currency && /^[A-Z]{3}$/.test(row.currency)
      ? { amount: (row.amountMinor / 10 ** safeDecimalPlaces(row.currency)).toFixed(safeDecimalPlaces(row.currency)), currency: row.currency }
      : {};
    const name = row?.name ? cleanSummaryText(row.name, 160) || null : null;
    return {
      id,
      name,
      ...money,
      ...(roles && name ? { permissions: [...(roles.get(id) ?? [])].sort() } : {}),
      ...(row?.builtInRole ? { builtInRole: row.builtInRole } : {}),
    };
  });
}

/** The kinds a reader exists for (the census holds every record kind to one). */
export const APPROVAL_RECORD_READERS: ReadonlySet<string> = new Set(Object.keys(READERS));
