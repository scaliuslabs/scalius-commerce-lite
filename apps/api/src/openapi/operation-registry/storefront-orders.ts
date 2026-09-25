// Agent operation registry rows for the storefront cart, checkout, order, receipt and payment routes.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_ORDER_OPERATIONS = {
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
  "storefront.cart.add": { revision: "required" },
  "storefront.cart.clear": { revision: "required" },
  "storefront.cart.get": {},
  "storefront.cart.remove": { revision: "required" },
  "storefront.cart.set_quantity": { revision: "required" },
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
  "storefront.delivery.set": { revision: "required" },
  "storefront.discount.apply": { revision: "required" },
  "storefront.discount.remove": { revision: "required" },
  "storefront.discounts_validate.validate": {
    exposure: "excluded",
    risk: "read",
    reason:
      "Legacy browser helper accepts client-asserted cart values and buyer phone; use storefront.discount.apply against the server-owned context cart.",
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
  "storefront.orders_lookup_status.status": {
    exposure: "excluded",
    principals: ["internal"],
    risk: "security",
    reason:
      "Service-authenticated storefront proxy for the Track-your-order status view; guessable order numbers stay behind the storefront's per-IP limit.",
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
  "storefront.receipt.get": {},
  "storefront.shipping_methods.list": { limits: { request: 16_384, response: 32_768 } },
} satisfies Record<string, OperationRegistryEntry>;
