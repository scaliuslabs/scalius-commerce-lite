import type {
  AgentArtifactOutput,
  AgentContinuationOutput,
  AgentOperationBatch,
  AgentOperationExposure,
  AgentOperationHttpMethod,
  AgentOperationIdempotency,
  AgentOperationMetadata,
  AgentOperationPrincipal,
  AgentOperationRevision,
  AgentOperationRisk,
  AgentOperationSurface,
  AgentOperationTransport,
} from "./agent-operation-manifest";

/**
 * The single declarative registry of `/api/v1` agent operations.
 *
 * One row per `operationId`. Everything that can be derived is derived:
 *
 * - `surface` comes from the operation-ID prefix;
 * - `risk` defaults to the HTTP method (`GET`/`HEAD` read, otherwise write);
 * - `principals` default to the surface;
 * - `batch` defaults to the exposure and risk;
 * - RBAC comes from `getRoutePermission()` and the route path;
 * - summaries, schemas, tags, and request/response shapes come from the route.
 *
 * A row therefore records only the reviewed deviations from those defaults.
 * An empty row (`{}`) is a plain executable operation with surface defaults.
 *
 * `openapi-contract.ts` turns each row into `x-scalius-agent` metadata, and
 * `agent-operation-manifest.ts` derives its reviewed device, one-time-secret,
 * and continuation policy sets from the same rows.
 */
export type OperationRegistryEntry = {
  /** Default `"execute"`. */
  exposure?: Exclude<AgentOperationExposure, "execute">;
  /** Default: `["admin"]` for dashboard/system, `["visitor","customer"]` for storefront. */
  principals?: readonly AgentOperationPrincipal[];
  /** Default: `"read"` for `GET`/`HEAD` routes, `"write"` otherwise. */
  risk?: AgentOperationRisk;
  /** Default `false`. Set when the operation calls an external provider. */
  openWorld?: true;
  /** Default `"none"`. */
  idempotency?: Exclude<AgentOperationIdempotency, "none">;
  /** Default `"none"`. */
  revision?: Exclude<AgentOperationRevision, "none">;
  /** Default: `"forbidden"` unless executable, then `"parallel"` for reads and `"sequential"` for mutations. */
  batch?: AgentOperationBatch;
  /** Default `"json"`. */
  transport?: Exclude<AgentOperationTransport, "json">;
  /** Byte ceilings. Defaults: request 1 MiB, response 65,536. */
  limits?: { request?: number; response?: number };
  /** Default `false`. */
  sensitive?: true;
  /** Default `false`. Reviewed against {@link ONE_TIME_SECRET_OPERATION_IDS}. */
  oneTimeSecret?: true;
  clientAction?: "direct-upload";
  artifact?: AgentArtifactOutput;
  continuation?: AgentContinuationOutput;
  /** Required when `exposure` is `"excluded"`, forbidden otherwise. */
  reason?: string;
  /**
   * Marks an executable dashboard operation that is deliberately outside the
   * curated agent intents in `agent-access/workflows/routes-dashboard.ts`.
   */
  internal?: true;
};

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

const DEFAULT_PRINCIPALS: Readonly<
  Record<AgentOperationSurface, readonly AgentOperationPrincipal[]>
> = {
  dashboard: ["admin"],
  storefront: ["visitor", "customer"],
  system: ["admin"],
};

export const OPERATIONS = {
  // ---------------------------------------------------------------------------
  // dashboard surface
  // ---------------------------------------------------------------------------

  "dashboard.abandoned_checkouts.bulk_delete_legacy": {
    exposure: "excluded",
    risk: "destructive",
    reason: "Legacy duplicate; use DELETE /admin/abandoned-checkouts.",
  },
  "dashboard.abandoned_checkouts.delete": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.abandoned_checkouts.list": {
    exposure: "excluded",
    reason:
      "Browser detail projection contains buyer PII and serialized checkout state; use dashboard.abandoned_checkouts.summaries_list for bounded routine agent listing.",
  },
  "dashboard.abandoned_checkouts.summaries_list": {},

  "dashboard.account.password_change": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
  },
  "dashboard.account.permissions.get": { limits: { response: 16_384 } },
  "dashboard.account.profile_update": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.account.security_get": { limits: { response: 16_384 } },
  "dashboard.account.sessions.list": {},
  "dashboard.account.sessions.revoke": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.account.sessions.revoke_others": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.account.two_factor.get": { limits: { response: 16_384 } },
  "dashboard.account.two_factor.method_challenge": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "dashboard.account.two_factor.method_update": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "dashboard.account.two_factor.verify": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
  },

  "dashboard.agent_access_authorization_requests_approve.approve": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 65_536, response: 16_384 },
    sensitive: true,
    reason:
      "Human OAuth approval and protocol continuation require a live 2FA-verified Super Admin browser session.",
  },

  "dashboard.agent_access_authorization_requests_deny.deny": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    sensitive: true,
    reason:
      "Human OAuth denial and protocol continuation require a live 2FA-verified Super Admin browser session.",
  },

  "dashboard.agent_access_authorization_requests.get": {
    exposure: "excluded",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Human OAuth consent display; unconsumed third-party client metadata is available only in the interactive dashboard consent flow.",
  },

  "dashboard.agent_access_device_authorizations_approve.approve": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 65_536, response: 16_384 },
    reason:
      "Human device-pairing approval mints a CLI credential for encrypted one-time delivery and requires live 2FA-verified Super Admin consent.",
  },

  "dashboard.agent_access_device_authorizations_deny.deny": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason: "Human device-pairing denial requires live 2FA-verified Super Admin consent.",
  },

  "dashboard.agent_access_device_authorizations_lookup.lookup": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 4_096, response: 16_384 },
    reason:
      "Human device-pairing verification accepts the short-lived user code only in the interactive dashboard pairing flow.",
  },

  "dashboard.agent_access_revoke_all.revoke_all": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Emergency tenant-wide credential kill switch; only a live 2FA-verified Super Admin browser session may invoke it.",
  },

  "dashboard.agent_access.browser_handoff.claim": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
    sensitive: true,
    reason:
      "Browser-only one-use claim returns sensitive continuation fields solely inside the authenticated browser session.",
  },
  "dashboard.agent_access.browser_handoff.open": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Browser-only handoff page bound to the same 2FA-verified administrator; agents receive only its non-secret resource link.",
  },
  "dashboard.agent_access.connections.events_list": { batch: "forbidden" },
  "dashboard.agent_access.connections.get": { batch: "forbidden" },
  "dashboard.agent_access.connections.list": { batch: "forbidden" },
  "dashboard.agent_access.connections.purge_revoked": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Irreversible purge of revoked and expired grants plus their audit history; only a live 2FA-verified Super Admin browser session may invoke it.",
  },
  "dashboard.agent_access.grants.revoke": {
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.agent_access.grants.update": {
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.agent_access.tokens.create": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
    sensitive: true,
    oneTimeSecret: true,
  },
  "dashboard.agent_access.tokens.rotate": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
    sensitive: true,
    oneTimeSecret: true,
  },

  "dashboard.analytics.create": {},
  "dashboard.analytics.delete_permanently": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.get": {},
  "dashboard.analytics.health": { limits: { response: 16_384 } },
  "dashboard.analytics.list": {},
  "dashboard.analytics.restore": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.set_active": {
    openWorld: true,
    revision: "required",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.analytics.update": { revision: "required" },

  "dashboard.attribute_values.create": {},
  "dashboard.attribute_values.delete": { risk: "destructive" },
  "dashboard.attribute_values.list": {},
  "dashboard.attribute_values.rename": {},

  "dashboard.attributes.bulk_delete": { risk: "destructive" },
  "dashboard.attributes.bulk_restore": {},
  "dashboard.attributes.create": {},
  "dashboard.attributes.delete_permanently": { risk: "destructive" },
  "dashboard.attributes.list": {
    exposure: "excluded",
    reason:
      "Legacy dashboard list may include up to 500 preset values per attribute; use dashboard.attributes.list_summaries and dashboard.attribute_values.list.",
  },
  "dashboard.attributes.list_summaries": {},
  "dashboard.attributes.restore": {},
  "dashboard.attributes.trash": { risk: "destructive" },
  "dashboard.attributes.update": {},

  "dashboard.cache.purge_all": { limits: { request: 16_384, response: 8_192 } },

  "dashboard.categories.bulk_delete": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.categories.bulk_restore": { revision: "required" },
  "dashboard.categories.create": {},
  "dashboard.categories.delete_permanently": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.categories.form_options": {},
  "dashboard.categories.get": {
    exposure: "excluded",
    reason: "Legacy oversized category aggregate; use dashboard.categories.get_section.",
  },
  "dashboard.categories.get_section": {},
  "dashboard.categories.list": {
    exposure: "excluded",
    reason:
      "Legacy dashboard list may include oversized category rich text; use dashboard.categories.list_summaries.",
  },
  "dashboard.categories.list_summaries": {},
  "dashboard.categories.publish_readiness": {},
  "dashboard.categories.restore": { revision: "required" },
  "dashboard.categories.set_status": { revision: "required" },
  "dashboard.categories.trash": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.categories.update": { revision: "required" },

  "dashboard.checkout_languages.active_get": {},
  "dashboard.checkout_languages.create": { limits: { request: 65_536, response: 16_384 } },
  "dashboard.checkout_languages.delete_permanently": {
    risk: "destructive",
    batch: "forbidden",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.checkout_languages.get": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.checkout_languages.list": { limits: { request: 16_384 } },
  "dashboard.checkout_languages.restore": { limits: { request: 16_384, response: 8_192 } },
  "dashboard.checkout_languages.trash": {
    risk: "destructive",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.checkout_languages.update": { revision: "required", limits: { request: 65_536, response: 16_384 } },

  "dashboard.checkout.flow_get": {},
  "dashboard.checkout.flow_update": { revision: "required" },
  "dashboard.checkout.readiness_get": {},

  "dashboard.collections.bulk_activate": {},
  "dashboard.collections.bulk_deactivate": {},
  "dashboard.collections.bulk_delete": { risk: "destructive" },
  "dashboard.collections.bulk_restore": {},
  "dashboard.collections.category_options": {},
  "dashboard.collections.create": {},
  "dashboard.collections.delete_permanently": { risk: "destructive" },
  "dashboard.collections.form_options": {},
  "dashboard.collections.get": {
    exposure: "excluded",
    reason: "Legacy oversized aggregate projection; use dashboard.collections.get_section.",
  },
  "dashboard.collections.get_by_ids": {},
  "dashboard.collections.get_section": {},
  "dashboard.collections.list": {},
  "dashboard.collections.product_options": {},
  "dashboard.collections.reorder": { revision: "required" },
  "dashboard.collections.restore": {},
  "dashboard.collections.trash": { risk: "destructive" },
  "dashboard.collections.update": { revision: "required" },
  "dashboard.collections.update_products": { revision: "required" },

  "dashboard.content.bulk_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.bulk_publish": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.bulk_restore": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.bulk_unpublish": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.create": {},
  "dashboard.content.get": {},
  "dashboard.content.list": {},
  "dashboard.content.permanently_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.restore": {
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.content.update": { revision: "required" },

  "dashboard.customer_requests.policy_get": {},
  "dashboard.customer_requests.policy_update": { revision: "required" },

  "dashboard.customers.bulk_delete": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.customers.create": {},
  "dashboard.customers.delete": { risk: "destructive" },
  "dashboard.customers.delete_permanently": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.customers.get": {},
  "dashboard.customers.history": {},
  "dashboard.customers.list": {},
  "dashboard.customers.restore": {},
  "dashboard.customers.update": {},

  "dashboard.delivery_locations.bulk_delete": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.delivery_locations.create": {},
  "dashboard.delivery_locations.delete_all": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.delivery_locations.get": {},
  "dashboard.delivery_locations.list": {},
  "dashboard.delivery_locations.pathao_import_chunk": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.delivery_locations.pathao_import_reset": { batch: "forbidden" },
  "dashboard.delivery_locations.pathao_import_status": {},
  "dashboard.delivery_locations.trash": { risk: "destructive" },
  "dashboard.delivery_locations.update": {},

  "dashboard.delivery_providers.create": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.delivery_providers.delete": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.delivery_providers.get": { limits: { response: 16_384 } },
  "dashboard.delivery_providers.list": {},
  "dashboard.delivery_providers.test": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.delivery_providers.test_credentials": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.delivery_providers.update": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },

  "dashboard.discounts.activate": { revision: "required" },
  "dashboard.discounts.archive": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.discounts.create": {},
  "dashboard.discounts.get": {},
  "dashboard.discounts.list": {},
  "dashboard.discounts.pause": { revision: "required" },
  "dashboard.discounts.preview": {
    risk: "read",
    revision: "required",
  },
  "dashboard.discounts.update": { revision: "required" },

  "dashboard.fraud_lookup.run": {
    risk: "read",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },

  "dashboard.fraud_providers.create": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.fraud_providers.delete": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.fraud_providers.list": {},
  "dashboard.fraud_providers.test": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.fraud_providers.update": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },

  "dashboard.hero_sliders.create": {},
  "dashboard.hero_sliders.get": {},
  "dashboard.hero_sliders.list": {},
  "dashboard.hero_sliders.trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.hero_sliders.update": { revision: "required" },

  "dashboard.home.activity": { limits: { request: 16_384, response: 32_768 } },
  "dashboard.home.summary": { limits: { request: 16_384 } },

  "dashboard.inventory_alerts.acknowledge": {},
  "dashboard.inventory_alerts.list": {},

  "dashboard.inventory_labels.generate_artifact": {
    risk: "read",
    batch: "forbidden",
    artifact: {
      mediaTypes: ["application/pdf", "text/csv", "text/html"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.inventory_labels.preview": { risk: "read" },

  "dashboard.inventory.adjust": { idempotency: "required" },
  "dashboard.inventory.adjust_stock": { idempotency: "required" },
  "dashboard.inventory.list": {},
  "dashboard.inventory.lookup_sku": {},
  "dashboard.inventory.movements_export": {
    risk: "read",
    batch: "forbidden",
    limits: { request: 16_384 },
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.inventory.set_stock": { idempotency: "required" },
  "dashboard.inventory.set_alert_level": {},

  "dashboard.media_folders.create": {},
  "dashboard.media_folders.delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.media_folders.list": {},
  "dashboard.media_folders.update": { revision: "required" },

  "dashboard.media.import_url": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.media.list": {},
  "dashboard.media.move": { revision: "required" },
  "dashboard.media.original": {
    exposure: "excluded",
    reason: "Binary original read for the dashboard's browser rendition pipeline; agents use the public media URL.",
  },
  "dashboard.media.permanently_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.media.restore": { revision: "required" },
  "dashboard.media.trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.media.update": { revision: "required" },
  "dashboard.media.upload_abort": { limits: { response: 16_384 } },
  "dashboard.media.upload_complete": {},
  "dashboard.media.upload_get": { limits: { response: 16_384 } },
  "dashboard.media.upload_initiate": { limits: { response: 16_384 } },
  "dashboard.media.upload_part": {
    batch: "forbidden",
    transport: "octet-stream",
    limits: { request: 5_242_880, response: 16_384 },
    clientAction: "direct-upload",
  },
  "dashboard.media.upload_reconcile": {
    exposure: "excluded",
    reason: "Internal expired-upload maintenance is not a merchant capability.",
  },
  "dashboard.media.variants_save": {
    exposure: "excluded",
    reason: "Browser-generated renditions from the dashboard; agent uploads get server-generated renditions at completion.",
  },

  "dashboard.meta_conversions.get": { limits: { response: 16_384 } },
  "dashboard.meta_conversions.logs_cleanup": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.meta_conversions.logs_clear": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.meta_conversions.logs_list": {},
  "dashboard.meta_conversions.update": {
    revision: "required",
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },

  "dashboard.navigation.authority_shadow": {
    exposure: "excluded",
    reason: "Internal normalized-authority migration parity report.",
  },
  "dashboard.navigation.items_create": { revision: "required" },
  "dashboard.navigation.items_delete": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.navigation.items_get": {},
  "dashboard.navigation.items_list": {},
  "dashboard.navigation.items_move": { revision: "required" },
  "dashboard.navigation.items_move_options": {},
  "dashboard.navigation.items_search": {},
  "dashboard.navigation.items_update": { revision: "required" },
  "dashboard.navigation.legacy_items_list": {
    exposure: "excluded",
    reason: "Superseded by normalized reusable-menu and item operations.",
  },
  "dashboard.navigation.menus_create": {},
  "dashboard.navigation.menus_get": {},
  "dashboard.navigation.menus_list": {},
  "dashboard.navigation.menus_publish": { revision: "required" },
  "dashboard.navigation.menus_restore": { revision: "required" },
  "dashboard.navigation.menus_rollback": { revision: "required" },
  "dashboard.navigation.menus_trash": {
    risk: "destructive",
    revision: "required",
    limits: { response: 16_384 },
  },
  "dashboard.navigation.menus_update": { revision: "required" },
  "dashboard.navigation.placements_list": {},
  "dashboard.navigation.placements_manifest": {},
  "dashboard.navigation.placements_save": { revision: "required" },
  "dashboard.navigation.products_preview_count": { limits: { response: 16_384 } },
  "dashboard.navigation.publications_list": {},
  "dashboard.navigation.resources_search": {},

  "dashboard.notifications.admin_rules_update": { revision: "required" },
  "dashboard.notifications.customer_rules_get": {},
  "dashboard.notifications.customer_rules_update": { revision: "required" },
  "dashboard.notifications.fcm_device_register": {
    exposure: "device",
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.notifications.fcm_token_cleanup": {
    exposure: "excluded",
    risk: "destructive",
    limits: { request: 65_536, response: 8_192 },
    reason:
      "Provider-delivery maintenance consumes raw FCM registration tokens and deactivates stale device rows; sends already deactivate provider-invalid tokens automatically, so this is not a merchant agent capability.",
  },
  "dashboard.notifications.firebase_get": {},
  "dashboard.notifications.firebase_update": {
    revision: "required",
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.notifications.template_test_send": { openWorld: true, batch: "forbidden" },
  "dashboard.notifications.templates_get": {},
  "dashboard.notifications.templates_update": { revision: "required" },

  "dashboard.orders.amendment_confirm": {
    idempotency: "required",
    revision: "required",
  },
  "dashboard.orders.amendment_preview": {
    risk: "read",
    revision: "required",
  },
  "dashboard.orders.archive": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.orders.bulk_confirm": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.bulk_fulfill": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.bulk_ship": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.catalog_products": {},
  "dashboard.orders.cod_get": {},
  "dashboard.orders.comment_add": {},
  "dashboard.orders.comment_delete": { risk: "destructive" },
  "dashboard.orders.cod_update": {
    risk: "financial",
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.create": { idempotency: "required" },
  "dashboard.orders.create_shipment": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.export": {
    batch: "forbidden",
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.orders.form_data": {},
  "dashboard.orders.fulfill": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.fulfillment_get": {},
  "dashboard.orders.get": {},
  "dashboard.orders.invoice_get": {},
  "dashboard.orders.invoice_issue": {
    idempotency: "required",
    revision: "required",
    batch: "forbidden",
  },
  "dashboard.orders.invoice_print": {
    batch: "forbidden",
    artifact: {
      mediaTypes: ["text/html"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 65_536,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.orders.items": {},
  "dashboard.orders.list": {},
  "dashboard.orders.notification_resend": {
    openWorld: true,
    idempotency: "required",
    batch: "forbidden",
  },
  "dashboard.orders.notification_retry": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.notifications": {},
  "dashboard.orders.payment_recovery_export": {
    batch: "forbidden",
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.orders.payment_recovery_link": {
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.orders.payment_recovery_list": {},
  "dashboard.orders.payments": {},
  "dashboard.orders.quote": { risk: "read" },
  "dashboard.orders.refund": {
    risk: "financial",
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.refund_reconcile": {
    risk: "financial",
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.restore": { revision: "required" },
  "dashboard.orders.return_approve": {
    idempotency: "required",
    revision: "required",
  },
  "dashboard.orders.return_cancel": {
    risk: "destructive",
    idempotency: "required",
    revision: "required",
  },
  "dashboard.orders.return_create": {
    idempotency: "required",
    revision: "required",
  },
  "dashboard.orders.return_get": {},
  "dashboard.orders.return_receive": {
    idempotency: "required",
    revision: "required",
  },
  "dashboard.orders.return_reconcile": {},
  "dashboard.orders.returns": {},
  "dashboard.orders.shipment_delete": {
    risk: "destructive",
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.shipment_get": {},
  "dashboard.orders.shipment_reconcile": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.shipment_refresh": {
    openWorld: true,
    batch: "forbidden",
  },
  "dashboard.orders.shipment_status_sync": {
    exposure: "excluded",
    openWorld: true,
    reason:
      "Legacy duplicate with no active merchant caller; use dashboard.orders.shipment_refresh.",
  },
  "dashboard.orders.shipment_unknown_lookup": {
    openWorld: true,
    idempotency: "required",
    revision: "required",
    batch: "forbidden",
  },
  "dashboard.orders.shipment_unknown_resolve": {
    openWorld: true,
    idempotency: "required",
    revision: "required",
    batch: "forbidden",
  },
  "dashboard.orders.shipments": {},
  "dashboard.orders.timeline": {},
  "dashboard.orders.support_request_update": {
    openWorld: true,
    revision: "optional",
    batch: "forbidden",
  },
  "dashboard.orders.update_details": { revision: "required" },
  "dashboard.orders.update_status": {
    openWorld: true,
    batch: "forbidden",
  },

  "dashboard.payments.methods_get": {},
  "dashboard.payments.methods_update": { revision: "required" },
  "dashboard.payments.sslcommerz_get": {},
  "dashboard.payments.sslcommerz_update": {
    revision: "required",
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.payments.stripe_get": {},
  "dashboard.payments.stripe_update": {
    revision: "required",
    risk: "security",
    batch: "forbidden",
  },

  "dashboard.policies.get": {},
  "dashboard.policies.update": { revision: "required" },

  "dashboard.product_options.save_matrix": { revision: "required" },

  "dashboard.product_variants.create": { revision: "required" },
  "dashboard.product_variants.list": {},
  "dashboard.product_variants.retire": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.product_variants.update": { revision: "required" },

  "dashboard.products.bulk_delete": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.products.bulk_update": { revision: "required" },
  "dashboard.products.create": { limits: { response: 16_384 } },
  "dashboard.products.duplicate": {},
  "dashboard.products.delete_permanently": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.products.get": {
    exposure: "excluded",
    reason: "Legacy oversized aggregate projection; use dashboard.products.get_section.",
  },
  "dashboard.products.get_by_ids": {},
  "dashboard.products.get_section": {},
  "dashboard.products.list": {
    exposure: "excluded",
    reason:
      "Legacy dashboard list may include oversized rich text and media projections; use dashboard.products.list_summaries.",
  },
  "dashboard.products.list_summaries": {},
  "dashboard.products.lookup_barcode": {},
  "dashboard.products.restore": { revision: "required" },
  "dashboard.products.stats": {},
  "dashboard.products.trash": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.products.update": { revision: "required" },
  "dashboard.products.update_section": {
    revision: "required",
    limits: { request: 16_384, response: 16_384 },
  },

  "dashboard.scanner_device.create_link": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },

  "dashboard.search_reindex.reindex": {
    exposure: "excluded",
    reason:
      "Placeholder returns ‘Reindex initiated’ without scheduling or performing reindex work; execution would report a false side effect.",
  },

  "dashboard.search.get_search": {
    exposure: "excluded",
    reason:
      "Legacy cross-resource search is unused by the dashboard; authoritative bounded product, category, and page list operations provide merchant search and filtering.",
  },

  "dashboard.security.policy_get": { limits: { request: 16_384 } },
  "dashboard.security.policy_update": {
    revision: "required",
    risk: "security",
    limits: { request: 131_072, response: 8_192 },
  },
  "dashboard.security.runtime_sources": { limits: { request: 16_384, response: 16_384 } },

  "dashboard.seo.feed_diagnostics": { limits: { request: 16_384 } },
  "dashboard.seo.feed_row_preview": {
    batch: "sequential",
    limits: { request: 16_384, response: 47_104 },
  },
  "dashboard.seo.live_probe": {
    openWorld: true,
    batch: "sequential",
    limits: { request: 16_384 },
  },
  "dashboard.seo.settings_get": { limits: { request: 16_384 } },
  "dashboard.seo.settings_update": { revision: "required", limits: { request: 65_536, response: 16_384 } },

  "dashboard.settings_abandoned_checkouts_cleanup.cleanup": {
    exposure: "excluded",
    risk: "destructive",
    limits: { response: 8_192 },
    reason:
      "Legacy dashboard-prefix mount of the service-authenticated post-order housekeeping callback; use explicit merchant deletion or scheduled retention cleanup.",
  },

  "dashboard.settings_abandoned_checkouts.abandoned_checkouts": {
    exposure: "excluded",
    limits: { response: 8_192 },
    reason:
      "Legacy dashboard-prefix mount of storefront abandoned-checkout snapshot persistence; no merchant UI invokes it, and agents must use protected context and cart operations rather than manufacture browser recovery snapshots.",
  },

  "dashboard.settings_footer.footer": {
    revision: "required",
    limits: { request: 65_536, response: 8_192 },
  },
  "dashboard.settings_footer.get_footer": { limits: { request: 16_384 } },

  "dashboard.settings_header.get_header": { limits: { request: 16_384 } },
  "dashboard.settings_header.header": {
    revision: "required",
    limits: { request: 65_536, response: 8_192 },
  },

  "dashboard.settings_homepage_presentation.get_homepage_presentation": { limits: { request: 16_384, response: 8_192 } },
  "dashboard.settings_homepage_presentation.homepage_presentation": {
    revision: "required",
    limits: { request: 16_384, response: 8_192 },
  },

  "dashboard.settings_sms.get_sms": {
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.settings_sms.sms": {
    risk: "security",
    revision: "required",
    limits: { request: 16_384, response: 8_192 },
  },

  "dashboard.settings.business_get": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings.business_update": { revision: "required", limits: { request: 16_384, response: 8_192 } },
  "dashboard.settings.currency_get": { limits: { request: 16_384, response: 8_192 } },
  "dashboard.settings.currency_update": { revision: "required", limits: { request: 16_384, response: 8_192 } },
  "dashboard.settings.customer_auth_get": {
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.settings.customer_auth_update": {
    revision: "required",
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.settings.customer_countries_get": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings.customer_countries_update": { revision: "required", limits: { request: 16_384, response: 8_192 } },
  "dashboard.settings.email_get": {
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.settings.email_update": {
    revision: "required",
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
  },
  "dashboard.settings.general_get": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Legacy aggregate of independently managed header and footer documents; excluded until those documents are exposed as bounded semantic read projections.",
  },
  "dashboard.settings.media_delivery_get": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings.media_delivery_update": { revision: "required", limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings.platform_get": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings.platform_update": { revision: "required", limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings.storefront_url_get": { limits: { request: 16_384, response: 8_192 } },
  "dashboard.settings.storefront_url_update": { revision: "required", limits: { request: 16_384, response: 8_192 } },

  "dashboard.shipments.delete": {
    exposure: "excluded",
    risk: "destructive",
    openWorld: true,
    reason: "Legacy duplicate; use dashboard.orders.shipment_delete.",
  },
  "dashboard.shipments.get": {
    exposure: "excluded",
    reason: "Legacy duplicate; use dashboard.orders.shipment_get.",
  },
  "dashboard.shipments.status_sync": {
    exposure: "excluded",
    openWorld: true,
    reason: "Legacy duplicate; use dashboard.orders.shipment_refresh.",
  },

  "dashboard.shipping_methods.list": {},
  "dashboard.shipping_zones.apply_template": { revision: "required", batch: "forbidden" },
  "dashboard.shipping_zones.create": {},
  "dashboard.shipping_zones.delete": { risk: "destructive" },
  "dashboard.shipping_zones.everywhere_else_update": { revision: "required" },
  "dashboard.shipping_zones.update": { revision: "required" },

  "dashboard.taxes.classes_create": {},
  "dashboard.taxes.classes_delete": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.taxes.classes_list": {},
  "dashboard.taxes.classes_update": { revision: "required" },
  "dashboard.taxes.classifications_list": {},
  "dashboard.taxes.classifications_update": { revision: "required" },
  "dashboard.taxes.configuration_get": {
    exposure: "excluded",
    reason:
      "Legacy aggregate can exceed the 65,536-byte structured-result ceiling because it returns every active jurisdiction; use dashboard.taxes.settings_get, dashboard.taxes.classes_list, dashboard.taxes.rates_list, and dashboard.taxes.jurisdictions_list.",
  },
  "dashboard.taxes.jurisdictions_list": {},
  "dashboard.taxes.preview": { risk: "read" },
  "dashboard.taxes.rates_create": {},
  "dashboard.taxes.rates_delete": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.taxes.rates_list": {},
  "dashboard.taxes.rates_update": { revision: "required" },
  "dashboard.taxes.settings_get": {},
  "dashboard.taxes.settings_update": { revision: "required" },

  "dashboard.team.permission_overrides.remove": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.permission_overrides.set": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.permissions.list": {},
  "dashboard.team.roles.create": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.roles.delete": {
    risk: "destructive",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.roles.get": { limits: { response: 16_384 } },
  "dashboard.team.roles.list": {},
  "dashboard.team.roles.update": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.user_roles.assign": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.user_roles.remove": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.invite": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.list": {},
  "dashboard.team.users.remove": {
    risk: "destructive",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.resend_invitation": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.revoke_invitation": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.set_suspension": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },

  "dashboard.theme.draft_rebase": { revision: "required" },
  "dashboard.theme.draft_save": { revision: "required" },
  "dashboard.theme.get": {},
  "dashboard.theme.preview_session_create": {
    exposure: "continuation",
    risk: "read",
    transport: "continuation",
    limits: { request: 65_536, response: 8_192 },
    sensitive: true,
    continuation: {
      method: "POST",
      urlJsonPointer: "/data/continuation/url",
      fieldsJsonPointer: "/data/continuation/fields",
      sensitiveFields: ["continuationCode"],
    },
  },
  "dashboard.theme.publish": { revision: "required" },
  "dashboard.theme.rollback": { revision: "required" },
  "dashboard.theme.save_legacy": {
    exposure: "excluded",
    reason: "Superseded by durable draft, preview, publish, version, and rollback workflow.",
  },
  "dashboard.theme.versions_list": {},
  "dashboard.theme.workspace_get": {},

  // ---------------------------------------------------------------------------
  // storefront surface
  // ---------------------------------------------------------------------------

  "storefront.abandoned_checkouts_cleanup.cleanup": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "destructive",
    idempotency: "supported",
    reason:
      "Service-authenticated post-order browser-checkout cleanup is automatic lifecycle maintenance, not a buyer action.",
  },

  "storefront.abandoned_checkouts.abandoned_checkouts": {
    exposure: "excluded",
    idempotency: "supported",
    reason:
      "Debounced browser form snapshot telemetry stores arbitrary checkout JSON and optional buyer phone; agent storefront context is the canonical cart and checkout state.",
  },

  "storefront.analytics_configurations.get_configurations": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Processed analytics snippets and trusted custom browser code are rendering infrastructure, not structured agent data.",
  },

  "storefront.articles.get_by_slug": {},
  "storefront.articles.list": {},

  "storefront.attributes.category_id_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "ID compatibility alias; use storefront.attributes.list_for_category with the public category slug.",
  },
  "storefront.attributes.list_filterable": { limits: { request: 16_384 } },
  "storefront.attributes.list_for_category": { limits: { request: 16_384 } },
  "storefront.attributes.list_for_search": { limits: { request: 16_384 } },

  "storefront.cart.add": { revision: "required" },
  "storefront.cart.clear": { revision: "required" },
  "storefront.cart.get": {},
  "storefront.cart.remove": { revision: "required" },
  "storefront.cart.set_quantity": { revision: "required" },

  "storefront.categories.get": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Unbounded browser category aggregate; use storefront.categories.get_section for reconstructable bounded detail.",
  },
  "storefront.categories.get_section": { limits: { request: 16_384, response: 32_768 } },
  "storefront.categories.list": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Unbounded browser category aggregate can exceed the structured-result ceiling; use storefront.categories.list_summaries plus storefront.categories.get_section.",
  },
  "storefront.categories.list_product_summaries": { limits: { request: 16_384 } },
  "storefront.categories.list_products": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Browser category listing embeds the unbounded category aggregate; use storefront.categories.list_product_summaries plus storefront.categories.get_section.",
  },
  "storefront.categories.list_summaries": { limits: { request: 16_384 } },

  "storefront.checkout_language.get_active": { limits: { request: 16_384, response: 16_384 } },

  "storefront.checkout.get_config": { limits: { request: 16_384, response: 16_384 } },
  "storefront.checkout.quote": { risk: "read" },
  "storefront.checkout.submit": {
    risk: "financial",
    idempotency: "required",
    revision: "required",
    limits: { response: 16_384 },
  },
  "storefront.checkout.validate": { risk: "read" },

  "storefront.collections.get": { limits: { request: 16_384 } },
  "storefront.collections.list": { limits: { request: 16_384 } },

  "storefront.context.close": { revision: "required" },
  "storefront.context.create": {},
  "storefront.context.get": {},

  "storefront.continuations.get": { exposure: "continuation" },

  "storefront.customer_auth_logout.logout": {
    exposure: "excluded",
    principals: ["customer"],
    risk: "security",
    idempotency: "supported",
    reason:
      "Revokes the browser customer-cookie session; use storefront.customer_auth.logout for context-bound customer authority.",
  },

  "storefront.customer_auth_me.get_me": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason:
      "Legacy customer-cookie PII projection; use the live delegated-authority storefront.customer_profile.get operation.",
  },

  "storefront.customer_auth_orders_claim_receipt.claim_receipt": {
    exposure: "excluded",
    principals: ["customer"],
    idempotency: "supported",
    reason:
      "Browser-only account attachment requires both the private raw receipt proof and the live customer cookie; agent order ownership uses delegated immutable customer authority instead.",
  },

  "storefront.customer_auth_orders_payment_session.payment_session": {
    exposure: "excluded",
    principals: ["customer"],
    risk: "financial",
    openWorld: true,
    sensitive: true,
    reason:
      "Returns provider client-secret or hosted-session material; use storefront.orders.payment.begin and storefront.payment.status with secure browser continuation.",
  },

  "storefront.customer_auth_orders_support_requests.support_requests": {
    exposure: "excluded",
    principals: ["customer"],
    openWorld: true,
    sensitive: true,
    reason:
      "Customer-cookie support mutation is duplicated by storefront.orders.support_request.create, which preserves delegated ownership and notification delivery.",
  },

  "storefront.customer_auth_orders.get": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason:
      "Private customer-cookie order detail projection; use storefront.orders.get with delegated immutable customer ownership.",
  },
  "storefront.customer_auth_orders.get_orders": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason:
      "Private customer-cookie account-order projection; use the context-bound storefront.orders.list operation.",
  },

  "storefront.customer_auth_profile.replace_profile": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason:
      "Cookie-authorized browser profile mutation returning PII; use storefront.customer_profile.update with live delegated authority.",
  },

  "storefront.customer_auth_send_otp.send_otp": {
    exposure: "excluded",
    risk: "security",
    openWorld: true,
    reason:
      "Browser OTP start accepts buyer identifiers and dispatches email or SMS; use storefront.customer_auth.begin and status so identifiers, OTPs, and session material stay outside agent I/O.",
  },

  "storefront.customer_auth_verify_otp.verify_otp": {
    exposure: "excluded",
    risk: "security",
    sensitive: true,
    reason:
      "Accepts a raw OTP and issues the customer session cookie; authentication must complete in the hosted storefront.customer_auth continuation.",
  },

  "storefront.customer_auth.begin": {
    exposure: "continuation",
    risk: "security",
    transport: "continuation",
    limits: { request: 16_384, response: 8_192 },
    sensitive: true,
    continuation: {
      method: "POST",
      urlJsonPointer: "/data/browser/url",
      fieldsJsonPointer: "/data/browser/fields",
      sensitiveFields: ["continuationCode"],
    },
  },
  "storefront.customer_auth.logout": {
    risk: "security",
    revision: "required",
  },
  "storefront.customer_auth.status": { exposure: "continuation" },

  "storefront.customer_profile.get": {},
  "storefront.customer_profile.update": {},

  "storefront.delivery.set": { revision: "required" },

  "storefront.discount.apply": { revision: "required" },
  "storefront.discount.remove": { revision: "required" },

  "storefront.discounts_validate.validate": {
    exposure: "excluded",
    risk: "read",
    reason:
      "Legacy browser helper accepts client-asserted cart values and buyer phone; use storefront.discount.apply against the server-owned context cart.",
  },

  "storefront.hero_sliders.get": {},
  "storefront.hero_sliders.list": {},

  "storefront.homepage.get": { limits: { request: 16_384 } },

  "storefront.layout.footer_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Compatibility alias; storefront.layout.get is the canonical buyer-shell authority.",
  },
  "storefront.layout.get": { limits: { request: 16_384 } },
  "storefront.layout.header_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Compatibility alias; storefront.layout.get is the canonical buyer-shell authority.",
  },

  "storefront.locations.area_summaries": { limits: { request: 16_384, response: 32_768 } },
  "storefront.locations.areas": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Unbounded browser location aggregate; use storefront.locations.area_summaries.",
  },
  "storefront.locations.cities": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Unbounded browser location aggregate; use storefront.locations.city_summaries.",
  },
  "storefront.locations.city_summaries": { limits: { request: 16_384, response: 32_768 } },
  "storefront.locations.zone_summaries": { limits: { request: 16_384, response: 32_768 } },
  "storefront.locations.zones": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Unbounded browser location aggregate; use storefront.locations.zone_summaries.",
  },

  "storefront.meta_events.events": {
    exposure: "excluded",
    openWorld: true,
    reason:
      "Browser analytics ingestion forwards browser-derived events and user data to Meta CAPI; agents must not fabricate browser telemetry.",
  },

  "storefront.navigation.get": {},
  "storefront.navigation.items_list": {},
  "storefront.navigation.menu_get": {},
  "storefront.navigation.menu_get_by_id": {},
  "storefront.navigation.placements_list": {},

  "storefront.orders_cart_validation.cart_validation": {
    exposure: "excluded",
    risk: "read",
    reason:
      "Legacy stateless browser cart preflight; use storefront.checkout.validate against authoritative context lines and delivery state.",
  },

  "storefront.orders_payment_recovery_send_otp.send_otp": {
    exposure: "excluded",
    risk: "security",
    openWorld: true,
    reason:
      "Starts private-order buyer verification; use storefront.payment_recovery.begin and status so identity and OTP state remain in the hosted continuation.",
  },

  "storefront.orders_payment_recovery_verify_otp.verify_otp": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    sensitive: true,
    reason:
      "Service-authenticated storefront proxy accepts a raw OTP and returns a private receipt bearer; use the hosted storefront.payment_recovery continuation.",
  },

  "storefront.orders_lookup_send_otp.send_otp": {
    exposure: "excluded",
    risk: "security",
    openWorld: true,
    reason:
      "Public Track-your-order verification sends a code to the contact saved on an order; buyers complete it in the storefront page, not through agents.",
  },

  "storefront.orders_lookup_verify_otp.verify_otp": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    sensitive: true,
    reason:
      "Service-authenticated storefront proxy accepts a raw OTP and returns a private receipt bearer for Track your order.",
  },

  "storefront.orders_receipt_owner_proof.owner_proof": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    sensitive: true,
    reason:
      "Service-authenticated storefront proxy trades a signed-in buyer's session for a private receipt bearer on their own order.",
  },

  "storefront.orders_receipt_support_requests.support_requests": {
    exposure: "excluded",
    openWorld: true,
    sensitive: true,
    reason:
      "Requires raw receipt proof in the request; use storefront.orders.support_request.create with stored receipt-hash or customer authority.",
  },

  "storefront.orders_receipt.get": {
    exposure: "excluded",
    sensitive: true,
    reason:
      "Private receipt projection requires raw receipt-bearer authority; use storefront.receipt.get through the context-to-receipt grant.",
  },

  "storefront.orders_status.get": {
    exposure: "excluded",
    reason:
      "Opaque browser checkout-attempt polling is transport recovery; retry storefront.checkout.submit with the same idempotency key or use continuation status.",
  },

  "storefront.orders_tax_quote.tax_quote": {
    exposure: "excluded",
    risk: "read",
    reason:
      "Legacy stateless browser quote accepts client cart and buyer facts; use storefront.checkout.quote against server-owned context state.",
  },

  "storefront.orders.get": {},
  "storefront.orders.list": {},
  "storefront.orders.orders": {
    exposure: "excluded",
    risk: "financial",
    idempotency: "required",
    sensitive: true,
    reason:
      "Legacy browser checkout accepts client-owned cart and buyer state and returns bearer tokens; use revision-checked, idempotent storefront.checkout.submit.",
  },
  "storefront.orders.payment.begin": {
    exposure: "continuation",
    risk: "financial",
    transport: "continuation",
    limits: { request: 16_384, response: 8_192 },
    sensitive: true,
    continuation: {
      method: "POST",
      urlJsonPointer: "/data/browser/url",
      fieldsJsonPointer: "/data/browser/fields",
      sensitiveFields: ["continuationCode"],
    },
  },
  "storefront.orders.support_request.create": {},

  "storefront.pages.get_by_id": {},
  "storefront.pages.get_by_slug": {},
  "storefront.pages.list": {},
  "storefront.pages.render_by_slug_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Storefront render-helper duplicate; use storefront.pages.get_by_slug as the canonical page-content authority.",
  },

  "storefront.payment_recovery.begin": {
    exposure: "continuation",
    risk: "security",
    transport: "continuation",
    limits: { request: 16_384, response: 8_192 },
    sensitive: true,
    continuation: {
      method: "POST",
      urlJsonPointer: "/data/browser/url",
      fieldsJsonPointer: "/data/browser/fields",
      sensitiveFields: ["continuationCode"],
    },
  },
  "storefront.payment_recovery.status": { exposure: "continuation" },

  "storefront.payment_reconcile.reconcile": {
    exposure: "excluded",
    risk: "financial",
    openWorld: true,
    idempotency: "supported",
    reason:
      "Provider reconciliation requires raw receipt proof; storefront.payment.status owns context-authorized safe reconciliation.",
  },

  "storefront.payment_session.session": {
    exposure: "excluded",
    risk: "financial",
    openWorld: true,
    sensitive: true,
    reason:
      "Requires raw receipt proof and returns a card client secret or hosted gateway session; use the secure storefront payment continuation.",
  },

  "storefront.payment.status": { exposure: "continuation" },

  "storefront.platform.get": { limits: { request: 16_384, response: 8_192 } },

  "storefront.products_feed.get_feed": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Crawler-only Merchant XML feed projection; agents use canonical catalog list, search, and bounded detail operations.",
  },

  "storefront.products_sitemap.get_sitemap": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Crawler-only sitemap projection is discovery infrastructure, not a buyer-visible catalog capability.",
  },

  "storefront.products.get": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Unbounded browser page aggregate; use storefront.products.get_section for reconstructable bounded detail.",
  },
  "storefront.products.get_section": { limits: { request: 16_384, response: 61_440 } },
  "storefront.products.list": { limits: { request: 16_384 } },
  "storefront.products.list_recommendations": { limits: { request: 16_384 } },
  "storefront.products.search_legacy": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Legacy variant aggregate duplicates storefront.products.list plus storefront.products.get_section.",
  },

  "storefront.ptproxy.get_ptproxy": {
    exposure: "excluded",
    principals: ["internal"],
    openWorld: true,
    reason:
      "Allowlisted Partytown script reverse proxy is browser transport infrastructure, not a semantic agent operation.",
  },

  "storefront.receipt.get": {},

  "storefront.search.predict": { limits: { request: 16_384, response: 32_768 } },

  "storefront.seo.get": { limits: { request: 16_384, response: 32_768 } },

  "storefront.shipping_methods.list": { limits: { request: 16_384, response: 32_768 } },

  // ---------------------------------------------------------------------------
  // system surface
  // ---------------------------------------------------------------------------

  "system.agent_artifacts.download": {
    exposure: "excluded",
    principals: ["admin", "visitor", "customer"],
    limits: { request: 16_384 },
    artifact: {
      mediaTypes: [
        "application/json",
        "application/pdf",
        "application/zip",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
        "text/csv",
        "text/html",
        "text/plain",
      ],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "direct-stream",
    },
    reason:
      "Dedicated authenticated one-use artifact transfer; not an operations.execute capability.",
  },

  "system.agent_auth.device_ack": {
    exposure: "device",
    risk: "security",
    idempotency: "supported",
    limits: { response: 16_384 },
  },
  "system.agent_auth.device_start": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "system.agent_auth.device_token": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "system.agent_auth.revoke": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
  },

  "system.auth_firebase_config.get_firebase_config": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Public Firebase browser and worker bootstrap configuration; not a semantic merchant or storefront action.",
  },

  "system.auth_me.get_me": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Legacy service-JWT claim introspection; agent identity comes from the live agent grant and principal.",
  },

  "system.auth_revoke.revoke": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    idempotency: "supported",
    reason:
      "Legacy service-JWT KV blacklist revocation; use agent credential self-revoke or agent-access grant management.",
  },

  "system.auth_token_stats.get_token_stats": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    reason:
      "Legacy JWT secret and blacklist diagnostics; not merchant-visible functionality or agent authentication state.",
  },

  "system.auth_token.get_token": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    sensitive: true,
    reason:
      "Static X-API-Token exchange that mints a short-lived service JWT; it is infrastructure authentication, not an agent grant or merchant capability, and its bearer output must not enter agent results.",
  },

  "system.meta.get": {
    exposure: "excluded",
    principals: ["internal"],
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Unauthenticated deployment compatibility probe for automation; it carries no merchant capability.",
  },
  "system.setup.get_setup": {
    exposure: "excluded",
    principals: ["internal"],
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Unauthenticated first-deployment readiness probe; setup is complete before an agent grant can exist.",
  },
  "system.setup.setup": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Unauthenticated first-admin credential bootstrap belongs to the setup ceremony and must not accept agent input.",
  },

  "system.storefront_continuations.bootstrap_claim": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 1_024, response: 8_192 },
    reason:
      "Service-authenticated storefront bridge that consumes a one-time browser bootstrap code and returns only its non-bearer continuation locator.",
  },
  "system.storefront_continuations.customer_auth_send_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.customer_auth_verify_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.get": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_reconcile": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_recovery_send_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_recovery_verify_otp": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.payment_start": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Internal service-JWT browser continuation bridge; use the protected context continuation operations.",
  },
  "system.storefront_continuations.theme_preview_exchange": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 65_536, response: 8_192 },
    sensitive: true,
    reason: "Service-authenticated server-only theme preview bearer exchange.",
  },

  "system.storefront_theme_preview.resolve": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    limits: { request: 16_384 },
    reason:
      "Private storefront cookie-bearer resolver; the preview token must never enter agent input or execution.",
  },
} satisfies Record<string, OperationRegistryEntry>;

export type OperationId = keyof typeof OPERATIONS;

const REGISTRY: Readonly<Record<string, OperationRegistryEntry>> = OPERATIONS;

export function registryEntry(operationId: string): OperationRegistryEntry | undefined {
  return Object.prototype.hasOwnProperty.call(REGISTRY, operationId)
    ? REGISTRY[operationId]
    : undefined;
}

export function operationSurface(operationId: string): AgentOperationSurface {
  const prefix = operationId.split(".", 1)[0];
  if (prefix === "dashboard" || prefix === "storefront" || prefix === "system") {
    return prefix;
  }
  throw new Error(`${operationId} has no recognised surface prefix.`);
}

/** `GET`/`HEAD` routes read; every other method mutates. */
export function methodRisk(method: string): AgentOperationRisk {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD" ? "read" : "write";
}

/**
 * Expands one registry row into the full `x-scalius-agent` metadata document.
 * Property order is the reviewed contract order and must stay stable: it is
 * serialized into the generated OpenAPI contract bytes.
 */
export function operationMetadata(
  operationId: string,
  method: AgentOperationHttpMethod | string,
  entry: OperationRegistryEntry,
): AgentOperationMetadata {
  const surface = operationSurface(operationId);
  const exposure: AgentOperationExposure = entry.exposure ?? "execute";
  const risk = entry.risk ?? methodRisk(method);
  const batch: AgentOperationBatch =
    entry.batch ??
    (exposure !== "execute" ? "forbidden" : risk === "read" ? "parallel" : "sequential");
  return {
    surface,
    exposure,
    principals: [...(entry.principals ?? DEFAULT_PRINCIPALS[surface])],
    risk,
    openWorld: entry.openWorld ?? false,
    idempotency: entry.idempotency ?? "none",
    revision: entry.revision ?? "none",
    batch,
    transport: entry.transport ?? "json",
    maximumResponseBytes: entry.limits?.response ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxRequestBytes: entry.limits?.request ?? DEFAULT_MAX_REQUEST_BYTES,
    sensitiveOutput: entry.sensitive ?? false,
    oneTimeSecretOutput: entry.oneTimeSecret ?? false,
    ...(entry.clientAction ? { requiredClientAction: entry.clientAction } : {}),
    ...(entry.artifact ? { artifactOutput: entry.artifact } : {}),
    ...(entry.continuation ? { continuationOutput: entry.continuation } : {}),
    ...(exposure === "excluded" && entry.reason ? { exclusionReason: entry.reason } : {}),
  };
}

function operationIdsWhere(
  predicate: (entry: OperationRegistryEntry) => boolean,
): ReadonlySet<string> {
  return new Set(
    Object.entries(REGISTRY)
      .filter(([, entry]) => predicate(entry))
      .map(([operationId]) => operationId),
  );
}

/** Operations reviewed for the device-pairing exposure class. */
export const DEVICE_OPERATION_IDS: ReadonlySet<string> = operationIdsWhere(
  (entry) => entry.exposure === "device",
);

/** Operations reviewed to return a one-time secret exactly once. */
export const ONE_TIME_SECRET_OPERATION_IDS: ReadonlySet<string> =
  operationIdsWhere((entry) => entry.oneTimeSecret === true);

/** Reviewed hosted-continuation output policies, keyed by operation ID. */
export const CONTINUATION_OUTPUTS: Readonly<
  Record<string, AgentContinuationOutput>
> = Object.fromEntries(
  Object.entries(REGISTRY)
    .filter(([, entry]) => entry.continuation !== undefined)
    .map(([operationId, entry]) => [operationId, entry.continuation as AgentContinuationOutput]),
);
