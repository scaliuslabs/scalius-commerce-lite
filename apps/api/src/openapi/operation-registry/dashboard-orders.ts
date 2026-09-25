// Agent operation registry rows for the dashboard order, shipment and abandoned-checkout routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_ORDER_OPERATIONS = {
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
  "dashboard.orders.fulfillment_create": {
    idempotency: "required",
    batch: "forbidden",
  },
  "dashboard.orders.fulfillment_void": {
    batch: "forbidden",
  },
  "dashboard.orders.pickup_ready": {
    idempotency: "required",
    batch: "forbidden",
  },
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
  "dashboard.orders.mark_delivered": {
    openWorld: true,
    batch: "forbidden",
  },
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
} satisfies Record<string, OperationRegistryEntry>;
