// App operation names: what an app passes to `ctx.api.call`. An app names
// the resource and the verb (`orders.get`, `products.create`), never the
// dashboard's route tree.
//
// The stable app API is one explicit, sealed table (`STABLE_APP_OPERATIONS`):
// each name is designed (`<resource>.<verb>`, the verb phrase starting with
// one of `APP_OPERATION_VERBS`) and maps to exactly one operation. The table
// is the stable tier: an operation is stable exactly when it is listed here
// (`openapi/operation-registry/index.ts`), and
// `apps/api/src/openapi/stable-operations.snapshot.json` is keyed by these
// names, so adding a route never moves a sealed name.
//
// Beta operations, which bundled first-party apps may also call, keep a
// derived name:
//
//   dashboard.resources.<resource>.<verb>  ->  <resource>.<verb>
//   dashboard.<resource>.<verb>            ->  <resource>.<verb>, unless a
//                                              resources operation owns it
//   objects.<...>                          ->  objects.<...>
//
// A derived name never takes a sealed one, and a sealed operation has only
// its sealed name. Storefront and system operations have no app name.

/** The shape of an app operation name: lower snake segments joined by dots. */
export const APP_OPERATION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/**
 * The closed list of verbs a stable name's verb phrase starts with
 * (`get`, `list_prices`, `set_status`, `bulk_set_stock`, `batch_create`).
 */
export const APP_OPERATION_VERBS = [
  "get",
  "list",
  "lookup",
  "create",
  "batch",
  "update",
  "upsert",
  "set",
  "delete",
  "trash",
  "restore",
  "archive",
  "activate",
  "pause",
  "retire",
  "void",
  "capture",
  "charge",
  "adjust",
  "import",
  "apply",
  "mark",
  "bulk",
] as const;

/** A stable name: `<resource>.<verb phrase>`, the phrase starting with a verb from {@link APP_OPERATION_VERBS}. */
export const STABLE_APP_OPERATION_NAME = new RegExp(
  `^[a-z][a-z0-9_]*\\.(?:${APP_OPERATION_VERBS.join("|")})(?:_[a-z0-9]+)*$`,
  "u",
);

/**
 * The sealed stable app API: app name -> operation id. Grouped by resource;
 * a name is never reused for another operation.
 */
export const STABLE_APP_OPERATIONS = {
  // ── Orders, fulfilment, payments ──
  "orders.list": "dashboard.resources.orders.list",
  "orders.get": "dashboard.resources.orders.get",
  "orders.create": "dashboard.resources.orders.create",
  "orders.set_status": "dashboard.orders.update_status",
  "orders.update_details": "dashboard.orders.update_details",
  "orders.mark_delivered": "dashboard.orders.mark_delivered",
  "orders.mark_pickup_ready": "dashboard.orders.pickup_ready",
  "order_timeline.list": "dashboard.orders.timeline",
  "returns.list": "dashboard.orders.returns",
  "returns.get": "dashboard.orders.return_get",
  "fulfillments.list": "dashboard.resources.fulfillments.list",
  "fulfillments.create": "dashboard.resources.fulfillments.create",
  "fulfillments.void": "dashboard.orders.fulfillment_void",
  "shipments.list": "dashboard.resources.shipments.list",
  "shipments.get": "dashboard.resources.shipments.get",
  "shipments.create": "dashboard.resources.shipments.create",
  "payments.list": "dashboard.resources.payments.list",
  "payments.create": "dashboard.resources.payments.create",
  "payments.charge": "dashboard.resources.payments.charge",
  "payments.capture": "dashboard.resources.payments.capture",
  "payments.void": "dashboard.resources.payments.void",
  "payment_methods.list": "dashboard.resources.payment_methods.list",
  "payment_methods.delete": "dashboard.resources.payment_methods.delete",
  "refunds.list": "dashboard.resources.refunds.list",
  "refunds.create": "dashboard.resources.refunds.create",

  // ── Products, variants, stock, prices ──
  "products.list": "dashboard.resources.products.list",
  "products.get": "dashboard.resources.products.get",
  "products.create": "dashboard.resources.products.create",
  "products.batch_create": "dashboard.resources.products.batch_create",
  "products.update": "dashboard.resources.products.update",
  "products.trash": "dashboard.products.trash",
  "products.restore": "dashboard.products.restore",
  "products.set_publications": "dashboard.products.publications_set",
  "products.bulk_set_status": "dashboard.resources.products.bulk_set_status",
  "products.bulk_publish": "dashboard.resources.products.bulk_publish",
  "variants.get": "dashboard.resources.variants.get",
  "variants.lookup": "dashboard.resources.variants.lookup",
  "variants.retire": "dashboard.product_variants.retire",
  "variants.bulk_set_prices": "dashboard.resources.variants.bulk_set_prices",
  "variants.bulk_set_stock": "dashboard.resources.variants.bulk_set_stock",
  "inventory.adjust": "dashboard.inventory.adjust",
  "inventory.set_stock": "dashboard.inventory.set_stock",
  "inventory.get_levels": "dashboard.inventory.levels",
  "inventory.list_levels": "dashboard.inventory.product_levels",
  "inventory_locations.list": "dashboard.inventory_locations.list",
  "price_lists.list": "dashboard.resources.price_lists.list",
  "price_lists.get": "dashboard.resources.price_lists.get",
  "price_lists.create": "dashboard.resources.price_lists.create",
  "price_lists.update": "dashboard.resources.price_lists.update",
  "price_lists.delete": "dashboard.resources.price_lists.delete",
  "price_lists.list_prices": "dashboard.resources.price_lists.prices_list",
  "price_lists.set_prices": "dashboard.resources.price_lists.prices_set",
  "sales_channels.list_products": "dashboard.sales_channels.products",
  "bulk_runs.list": "dashboard.resources.bulk_runs.list",
  "bulk_runs.get": "dashboard.resources.bulk_runs.get",
  "app_content.delete": "dashboard.resources.app_content.delete",

  // ── Catalog content ──
  "brands.get": "dashboard.brands.get",
  "brands.create": "dashboard.brands.create",
  "brands.batch_create": "dashboard.brands.batch_create",
  "brands.update": "dashboard.brands.update",
  "brands.set_status": "dashboard.brands.set_status",
  "brands.trash": "dashboard.brands.trash",
  "brands.restore": "dashboard.brands.restore",
  "categories.list": "dashboard.resources.categories.list",
  "categories.get": "dashboard.resources.categories.get",
  "categories.create": "dashboard.categories.create",
  "categories.batch_create": "dashboard.categories.batch_create",
  "categories.update": "dashboard.categories.update",
  "categories.set_status": "dashboard.categories.set_status",
  "categories.trash": "dashboard.categories.trash",
  "categories.restore": "dashboard.categories.restore",
  "collections.list": "dashboard.resources.collections.list",
  "collections.get": "dashboard.resources.collections.get",
  "collections.create": "dashboard.collections.create",
  "collections.update": "dashboard.collections.update",
  "collections.update_products": "dashboard.collections.update_products",
  "collections.trash": "dashboard.collections.trash",
  "collections.restore": "dashboard.collections.restore",
  "pages.get": "dashboard.content.get",
  "pages.create": "dashboard.content.create",
  "pages.update": "dashboard.content.update",
  "discounts.get": "dashboard.discounts.get",
  "discounts.create": "dashboard.discounts.create",
  "discounts.update": "dashboard.discounts.update",
  "discounts.activate": "dashboard.discounts.activate",
  "discounts.pause": "dashboard.discounts.pause",
  "discounts.archive": "dashboard.discounts.archive",
  "media.list": "dashboard.media.list",
  "media.get": "dashboard.media.get",
  "media.import_url": "dashboard.media.import_url",
  "media.update": "dashboard.media.update",
  "media.trash": "dashboard.media.trash",
  "menus.get": "dashboard.resources.menus.get",
  "menus.create": "dashboard.resources.menus.create",
  "menus.update": "dashboard.resources.menus.update",
  "theme.get": "dashboard.resources.theme.get",
  "theme.apply_template": "dashboard.resources.theme.apply_template",
  "theme.set_section_settings": "dashboard.resources.theme.section_settings_set",

  // ── Customers ──
  "customers.list": "dashboard.resources.customers.list",
  "customers.get": "dashboard.resources.customers.get",
  "customers.create": "dashboard.customers.create",
  "customers.update": "dashboard.customers.update",
  "customers.set_tags": "dashboard.customers.tags_set",
  "customers.bulk_tag": "dashboard.resources.customers.bulk_tag",

  // ── Gift cards ──
  "gift_cards.list": "dashboard.resources.gift_cards.list",
  "gift_cards.get": "dashboard.resources.gift_cards.get",
  "gift_cards.create": "dashboard.resources.gift_cards.create",
  "gift_cards.update": "dashboard.resources.gift_cards.update",
  "gift_cards.adjust": "dashboard.resources.gift_cards.adjust",

  // ── Custom fields ──
  "custom_field_definitions.list": "dashboard.custom_field_definitions.list",
  "custom_field_definitions.get": "dashboard.custom_field_definitions.get",
  "custom_fields.get_brand_values": "dashboard.custom_fields.get_brand_values",
  "custom_fields.set_brand_values": "dashboard.custom_fields.set_brand_values",
  "custom_fields.get_category_values": "dashboard.custom_fields.get_category_values",
  "custom_fields.set_category_values": "dashboard.custom_fields.set_category_values",
  "custom_fields.get_collection_values": "dashboard.custom_fields.get_collection_values",
  "custom_fields.set_collection_values": "dashboard.custom_fields.set_collection_values",
  "custom_fields.get_customer_values": "dashboard.custom_fields.get_customer_values",
  "custom_fields.set_customer_values": "dashboard.custom_fields.set_customer_values",
  "custom_fields.get_order_values": "dashboard.custom_fields.get_order_values",
  "custom_fields.set_order_values": "dashboard.custom_fields.set_order_values",
  "custom_fields.get_page_values": "dashboard.custom_fields.get_page_values",
  "custom_fields.set_page_values": "dashboard.custom_fields.set_page_values",
  "custom_fields.get_product_values": "dashboard.custom_fields.get_product_values",
  "custom_fields.set_product_values": "dashboard.custom_fields.set_product_values",
  "custom_fields.get_variant_values": "dashboard.custom_fields.get_variant_values",
  "custom_fields.set_variant_values": "dashboard.custom_fields.set_variant_values",

  // ── Objects ──
  "object_types.list": "objects.types.list",
  "object_types.get": "objects.types.get",
  "object_types.create": "objects.types.create",
  "object_types.update": "objects.types.update",
  "object_types.delete": "objects.types.delete",
  "objects.list": "objects.list",
  "objects.get": "objects.get",
  "objects.upsert": "objects.upsert",
  "objects.delete": "objects.delete",

  // ── Store settings and webhooks ──
  "languages.list": "dashboard.languages.list",
  "delivery_locations.import": "dashboard.delivery_locations.import",
  "webhook_subscriptions.list": "dashboard.resources.webhook_subscriptions.list",
  "webhook_subscriptions.create": "dashboard.resources.webhook_subscriptions.create",
  "webhook_subscriptions.update": "dashboard.resources.webhook_subscriptions.update",
  "webhook_subscriptions.delete": "dashboard.resources.webhook_subscriptions.delete",
} as const satisfies Record<string, string>;

export type StableAppOperationName = keyof typeof STABLE_APP_OPERATIONS;

/** Operation ids of the stable tier. */
export const STABLE_OPERATION_IDS: ReadonlySet<string> = new Set(Object.values(STABLE_APP_OPERATIONS));

const RESOURCES = "dashboard.resources.";
const DASHBOARD = "dashboard.";

/**
 * Every operation's app name, from the operation ids the host knows:
 * `{ name -> operationId }`. Sealed names come from the table; the rest are
 * derived. Throws on two operations with one name.
 */
export function appOperationNames(operationIds: Iterable<string>): Map<string, string> {
  const ids = new Set(operationIds);
  const names = new Map<string, string>();
  for (const [name, operationId] of Object.entries(STABLE_APP_OPERATIONS)) {
    if (ids.has(operationId)) names.set(name, operationId);
  }
  for (const operationId of [...ids].sort()) {
    if (STABLE_OPERATION_IDS.has(operationId)) continue;
    let name: string | null = null;
    if (operationId.startsWith(RESOURCES)) name = operationId.slice(RESOURCES.length);
    else if (operationId.startsWith("objects.")) name = operationId;
    else if (operationId.startsWith(DASHBOARD)) {
      const candidate = operationId.slice(DASHBOARD.length);
      if (!ids.has(RESOURCES + candidate)) name = candidate;
    }
    if (!name || !APP_OPERATION_NAME.test(name) || Object.hasOwn(STABLE_APP_OPERATIONS, name)) continue;
    const taken = names.get(name);
    if (taken) throw new Error(`App operation name ${name} would name both ${taken} and ${operationId}.`);
    names.set(name, operationId);
  }
  return names;
}
