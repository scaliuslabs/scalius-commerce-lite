// App access scopes (docs/platform/PLUGINS.md, "Scopes"; COMMERCE-HOOKS H5):
// the frozen names a manifest asks for (`scopes`), the merchant approves on
// the consent screen, and the platform maps to its RBAC permissions here, in
// this one table. RBAC can be refactored freely; an installed app keeps the
// same scope names.
//
// Part of the versioned plugin API: within `PLUGIN_API_VERSION` names are
// only added, never renamed or removed, and a scope never gains a capability
// its description does not state.
//
// Three tiers:
//   - access scopes (`read_*`, `write_*`) confer RBAC permissions (`rbac`);
//   - protected customer data scopes (`protects`) confer none: each reveals
//     one category of buyer contact data (names, emails, phones, street
//     addresses) wherever the app's access scopes already reach. Without it,
//     those fields read null in operation responses and provider inputs leave
//     them out (./protected-data.ts);
//   - capability scopes (`sensitive`, no `rbac`) confer none either: each
//     widens one host capability the bridge checks by the scope's name
//     (`send_messages_any`: `ctx.messaging` to any address).
//
// Rules of the table:
//   - `write_*` includes its `read_*` (an app that edits can read what it edits);
//   - no access scope reveals protected customer data by itself;
//   - every RBAC permission is plugin-grantable: no team, agent access,
//     webhook or app management (packages/core/src/modules/plugins/grants.ts,
//     checked by its test);
//   - `staff` is the one dashboard permission a staff member needs to use an
//     app admin route the manifest gates with this scope (`routes.admin[].scope`).
//
// What a scope lets a third-party app call is its RBAC ∩ the stable
// operations (`x-scalius-agent.stability`); bundled first-party apps also
// reach `beta` operations.

import type { ProtectedCustomerData } from "./protected-data";

/** One scope: the RBAC permissions it confers and the staff permission behind its admin routes. */
export interface PluginScopeDefinition {
  readonly rbac: readonly string[];
  readonly staff: string;
  /** A protected customer data scope: the category it reveals (it confers no RBAC). */
  readonly protects?: ProtectedCustomerData;
  /** A capability scope: confers no RBAC, widens one host capability, and the consent screen marks it Sensitive. */
  readonly sensitive?: true;
}

const PRODUCTS_READ = ["products.view", "categories.view", "collections.view", "attributes.view"] as const;
const INVENTORY_READ = ["inventory.view"] as const;
const OBJECTS_READ = ["objects.view"] as const;

export const PLUGIN_SCOPES = {
  /** Products, variants with their stock totals, collections, categories, brands and attributes. */
  read_products: { rbac: PRODUCTS_READ, staff: "products.view" },
  /**
   * Create, edit, trash and restore products, variants, collections,
   * categories, brands and attributes; set product custom fields. Never
   * changes stock (`write_inventory`) and never deletes permanently.
   */
  write_products: {
    rbac: [
      ...PRODUCTS_READ,
      "products.create", "products.edit", "products.delete", "products.restore",
      "categories.create", "categories.edit", "categories.delete", "categories.restore",
      "collections.create", "collections.edit", "collections.delete", "collections.restore", "collections.toggle_status",
      "attributes.create", "attributes.edit", "attributes.delete",
    ],
    staff: "products.edit",
  },
  /** Stock levels per location, locations, suppliers, purchase orders and transfers. */
  read_inventory: { rbac: INVENTORY_READ, staff: "inventory.view" },
  /**
   * Adjust and set stock (on hand, per location), including the quantities a
   * product or SKU write sets; manage locations, suppliers, purchase orders
   * and transfers.
   */
  write_inventory: { rbac: [...INVENTORY_READ, "products.adjust_stock", "inventory.manage"], staff: "products.adjust_stock" },
  /** Orders, their lines, payments, shipments, returns and timeline; abandoned checkouts. Contact fields need the protected data scopes. */
  read_orders: { rbac: ["orders.view"], staff: "orders.view" },
  /** Create orders, change their status and details, add timeline notes, set order custom fields. */
  write_orders: { rbac: ["orders.view", "orders.create", "orders.edit", "orders.change_status"], staff: "orders.edit" },
  /** Hand over order lines, create and void fulfilments and courier shipments. */
  write_fulfillments: { rbac: ["orders.view", "orders.manage_shipments"], staff: "orders.manage_shipments" },
  /** Customers, their tags and marketing consent; email, text or push a customer by id (`ctx.messaging`). Contact fields need the protected data scopes. */
  read_customers: { rbac: ["customers.view"], staff: "customers.view" },
  /** Create and edit customers, their tags and custom fields. */
  write_customers: { rbac: ["customers.view", "customers.create", "customers.edit"], staff: "customers.edit" },
  /** Send marketing email and SMS to customers who agreed to receive it. The platform resolves the address; the app never sees it. */
  write_marketing: { rbac: ["marketing.send"], staff: "marketing.send" },
  /**
   * Email and text any address from the store's sender (`ctx.messaging` with
   * any `to`). Without it an app reaches customers by id, the store's staff
   * and the addresses in its declared `messaging.recipients` fields only.
   * Sensitive: mail from the store's own domain to anyone. Confers no RBAC.
   */
  send_messages_any: { rbac: [], staff: "marketing.send", sensitive: true },
  /** Buyers' and recipients' names. */
  read_customer_names: { rbac: [], staff: "customers.view", protects: "name" },
  /** Buyers' email addresses. */
  read_customer_emails: { rbac: [], staff: "customers.view", protects: "email" },
  /** Buyers' and recipients' phone numbers. */
  read_customer_phones: { rbac: [], staff: "customers.view", protects: "phone" },
  /** Street addresses: address lines, company and neighbourhood (the region is not protected). */
  read_customer_addresses: { rbac: [], staff: "customers.view", protects: "address" },
  /** Discounts and their rules. */
  read_discounts: { rbac: ["discounts.view"], staff: "discounts.view" },
  /** Create, edit, pause, activate and archive discounts. */
  write_discounts: {
    rbac: ["discounts.view", "discounts.create", "discounts.edit", "discounts.delete", "discounts.toggle_status"],
    staff: "discounts.edit",
  },
  /** Content pages. */
  read_content: { rbac: ["pages.view"], staff: "pages.view" },
  /** Create, edit, publish and trash content pages; set their custom fields. */
  write_content: { rbac: ["pages.view", "pages.create", "pages.edit", "pages.delete", "pages.publish"], staff: "pages.edit" },
  /** The store's object types and records outside the app's own namespace (`custom.*`). */
  read_objects: { rbac: OBJECTS_READ, staff: "objects.view" },
  /** Create, edit and delete records of the store's object types. */
  write_objects: { rbac: [...OBJECTS_READ, "objects.edit"], staff: "objects.edit" },
  /** Files in the media library. */
  read_files: { rbac: ["media.view"], staff: "media.view" },
  /** Import files from an HTTPS address, rename, move and trash them. */
  write_files: { rbac: ["media.view", "media.upload", "media.delete", "media.manage_folders"], staff: "media.upload" },
  /** Store settings: business details, web addresses, markets, languages and custom field definitions. */
  read_settings: { rbac: ["settings.general.view"], staff: "settings.general.view" },
  /** Add and update delivery places (a place dataset) through the place import; never delete them. */
  write_places: {
    rbac: ["settings.delivery_locations.view", "settings.delivery_locations.import"],
    staff: "settings.delivery_locations.import",
  },
} as const satisfies Record<string, PluginScopeDefinition>;

export type PluginScope = keyof typeof PLUGIN_SCOPES;

/** Every scope name, in the table's order (read before write within an area). */
export const PLUGIN_SCOPE_NAMES = Object.keys(PLUGIN_SCOPES) as [PluginScope, ...PluginScope[]];

export function isPluginScope(value: string): value is PluginScope {
  return Object.prototype.hasOwnProperty.call(PLUGIN_SCOPES, value);
}

/** Whether the consent screen marks a scope Sensitive by itself: protected customer data, or a sensitive capability. */
export function isSensitivePluginScope(scope: PluginScope): boolean {
  const definition = PLUGIN_SCOPES[scope] as PluginScopeDefinition;
  return definition.protects !== undefined || definition.sensitive === true;
}

/** Whether a scope widens a host capability instead of conferring RBAC (`send_messages_any`). */
export function isCapabilityScope(scope: PluginScope): boolean {
  return (PLUGIN_SCOPES[scope] as PluginScopeDefinition).sensitive === true;
}

/** Whether a scope reveals protected customer data instead of conferring RBAC. */
export function isProtectedDataScope(scope: PluginScope): boolean {
  return (PLUGIN_SCOPES[scope] as PluginScopeDefinition).protects !== undefined;
}

/** The RBAC permissions a set of scopes confers (unknown names confer nothing). */
export function pluginScopePermissions(scopes: Iterable<string>): Set<string> {
  const permissions = new Set<string>();
  for (const scope of scopes) {
    if (!isPluginScope(scope)) continue;
    for (const permission of PLUGIN_SCOPES[scope].rbac) permissions.add(permission);
  }
  return permissions;
}

/**
 * The scope a legacy manifest's RBAC permission becomes (stored manifests and
 * grants written before scopes): the first scope in table order that confers
 * it, or null (dropped: a grant only ever narrows).
 */
export function legacyPermissionScope(permission: string): PluginScope | null {
  return PLUGIN_SCOPE_NAMES.find((scope) => (PLUGIN_SCOPES[scope].rbac as readonly string[]).includes(permission)) ?? null;
}
