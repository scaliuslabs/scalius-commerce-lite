// The inventory of every stored state: each `status` or `state` column of the
// schema, and what holds its legal moves. state-machines.test.ts walks the
// schema, so a new state column fails until it is entered here, and an entry
// for a column that is gone fails too.
//
// - MACHINES: the moves are declared once (`@scalius/shared/machine`) and the
//   writers go through the declaration.
// - IMPLICIT: the column moves between states, but its legal moves live only
//   in its writers (scattered `if`s and WHERE clauses). This list is the open
//   work: it only shrinks. To take a column off it, declare its machine, send
//   every writer through it (the update names the move's source states), and
//   move the entry to MACHINES.
// - NOT_MACHINES: a state nothing moves edge by edge (a projection of other
//   rows, a provider's own words, a record of one outcome).
import type { AnyMachine } from "@scalius/shared/machine";
import { COD_MACHINE, ORDER_MACHINE } from "@scalius/shared/order-state";
import { REVIEW_MACHINE } from "@scalius/shared/reviews";
import { INVITATION_MACHINE } from "./auth/invitation-state";
import { GRANT_MACHINE, PAIRING_MACHINE } from "./modules/agent-access/lifecycle";
import { PURCHASE_ORDER_MACHINE, SUPPLIER_MACHINE } from "./modules/inventory/purchasing-state";
import { MEDIA_MACHINE, MEDIA_UPLOAD_MACHINE } from "./modules/media/media.machines";
import { DISPUTE_MACHINE } from "./modules/payments/disputes";
import { SESSION_MACHINE } from "./modules/payments/session-lifecycle";

type StateColumn = `${string}.${string}`;

export const MACHINES: Readonly<Record<StateColumn, AnyMachine>> = {
    "orders.status": ORDER_MACHINE,
    "cod_tracking.cod_status": COD_MACHINE,
    "product_reviews.status": REVIEW_MACHINE,
    "payment_disputes.status": DISPUTE_MACHINE,
    // The hosted sessions of the table. Its off-session command rows are below.
    "payment_session_attempts.status": SESSION_MACHINE,
    "agent_grants.status": GRANT_MACHINE,
    "agent_device_authorizations.status": PAIRING_MACHINE,
    "admin_invitations.status": INVITATION_MACHINE,
    "purchase_orders.status": PURCHASE_ORDER_MACHINE,
    "suppliers.status": SUPPLIER_MACHINE,
    "media.status": MEDIA_MACHINE,
    "media_upload_sessions.state": MEDIA_UPLOAD_MACHINE,
};

export const NOT_MACHINES: Readonly<Record<StateColumn, string>> = {
    "orders.payment_status": "projection of the order's payments (payments/payment-state.ts deriveOrderPaymentState)",
    "orders.fulfillment_status": "projection of the fulfilment ledger (fulfilment/ledger.ts orderFulfilmentStatusSql)",
    "order_refunds.status": "projection of the refund's attempts, kept by triggers",
    "delivery_shipments.raw_status": "the courier's own words",
    "refund_attempts.provider_status": "the provider's own words",
    "notification_delivery_receipts.provider_status": "the provider's own words",
    "auth_otp_delivery_receipts.provider_status": "the provider's own words",
    "customer_marketing_consent_events.state": "append-only history of customer_marketing_consents.state",
    "customer_marketing_consent_events.previous_state": "append-only history of customer_marketing_consents.state",
    "meta_conversions_logs.status": "the outcome of one send, written once",
    "order_receipts.status": "one value (`active`) is ever written",
};

/** What is known about each column's unwritten rules, for whoever declares its machine. */
export const IMPLICIT: Readonly<Record<StateColumn, string>> = {
    // Orders and delivery
    "delivery_shipments.status": "17 states, about 20 writers, most unguarded; couriers report in any order, so it needs settled/open rules more than an edge table",
    "order_returns.status": "inline `status IN` checks per command in orders/returns/returns.ts, guarded by version",
    "order_return_commands.status": "idempotency claim: processing, committed",
    "order_support_requests.status": "admin moves are a table (orders/order-support-requests.ts ADMIN_SUPPORT_REQUEST_TRANSITIONS); `withdrawn` has no writer",
    "order_fulfillments.status": "active, voided; guarded writes in fulfilment/ledger.ts",
    "checkout_attempts.status": "only `committed` is ever written; `processing` and `failed` are read but never set",
    "admin_order_create_attempts.status": "claim with a lease: processing, committed, failed",
    "order_payment_recovery_challenges.status": "one-time code: pending, consumed, locked",
    "tax_document_commands.status": "leased command with a sweep (tax/documents.ts)",
    "payment_plans.status": "`deposit_paid` never moves on a refund; only the stale-checkout sweep cancels",
    // Money
    "order_payments.status": "about 20 writers in 9 files; `confirmed` has no writer; the money-in-flight set is retyped in 8 places",
    "refund_attempts.status": "the in-flight set is declared 7 times (core, database, triggers, dashboard); finalize names no source state",
    "webhook_events.status": "inbound claim; finishing writes name the row by id only, with no claim token",
    "payouts.status": "forward-only by rank (payouts/payouts.ts) and a trigger",
    "payout_reversals.status": "forward-only by rank and a trigger",
    "customer_payment_methods.status": "active, removed; a re-saved method returns to active",
    "gift_cards.status": "`disabled` has two causes (staff, refund clawback) that the column cannot tell apart",
    // Stock and supply
    "inventory_transfers.status": "inline assertStatus plus a revision guard (inventory/transfers.ts)",
    "inventory_locations.status": "active, archived",
    "product_low_stock_alerts.alert_status": "two implementations in inventory/alerts.ts and a third derivation in the list read",
    "warranty_claims.status": "any status to any, by design, guarded by version",
    "digital_assets.status": "draft, ready, archived; guarded by version",
    "digital_asset_uploads.status": "`aborted` means both cancelled and replaced; two writers name the row by id only",
    "digital_licence_keys.status": "available to assigned or revoked, both final",
    // Catalog and content
    "promotions.status": "draft, active, paused, archived; scheduled and expired are derived from dates in three places",
    "price_lists.status": "draft, active",
    "markets.status": "draft, active; the backup market must stay active",
    "sales_channels.status": "mirrors its app's status",
    "categories.status": "publication state with a trash flag",
    "brands.status": "publication state with a trash flag",
    "object_records.status": "two vocabularies in one column: `active`, or draft and published for storefront types",
    "order_review_requests.status": "scheduled to queued or skipped, by trigger and drain",
    // Queues and jobs: the same claim, retry and give-up machine written once per table
    "event_outbox.status": "outbox: lease 300 s, 8 tries, dead_lettered",
    "webhook_event_deliveries.status": "outbox: lease 120 s, 8 tries, exhausted; staff retry",
    "plugin_event_deliveries.status": "outbox: lease 120 s, 8 tries, exhausted; held deliveries are `pending`",
    "notification_outbox.status": "outbox: lease 120 s, 8 tries, dead_lettered; no database check on the column",
    "notification_delivery_receipts.status": "receipt per channel; `delivered` has no writer",
    "auth_otp_delivery_receipts.status": "a copy of the notification receipt; `delivered` has no writer",
    "meta_capi_purchase_outbox.status": "outbox: lease 300 s, gives up by age as `skipped`",
    "tracking_deliveries.status": "outbox: lease 300 s, 12 tries, `skipped`",
    "bulk_runs.status": "running, done, failed with a lease; a cancelled app job is stored as failed",
    "plugin_cron_runs.status": "insert-claim with a lease: running, succeeded, failed",
    "plugin_installations.status": "installed, active, disabled, failed; 8 writers with three kinds of guard",
    "webhook_subscriptions.status": "active, disabled with a reason",
    "conversations.status": "open, pending, closed (conversations/threads.ts statusAfter)",
    "conversation_channel_messages.status": "receipts move by conversations/channels.ts RECEIPT_FROM",
    "marketing_runs.status": "declared with checks, never read or written",
    "marketing_run_recipients.status": "declared with checks, never read or written",
    // Identity and access
    "agent_artifact_handles.status": "active to consumed, expired or failed; guarded writes",
    "agent_browser_handoffs.status": "active to consumed or expired; also carries approvals",
    "agent_authorization_requests.status": "7 states with a per-state column check; the maintenance job expires an approved request nobody completed",
    "agent_storefront_contexts.status": "`revoked` has no writer",
    "agent_storefront_continuations.status": "`failed` has no writer",
    "admin_setup_claims.status": "claim with a lease",
    "admin_invitations.delivery_status": "pending, sent, failed; unguarded",
    "customer_auth_otp_challenges.status": "one-time code: pending, consumed, locked",
    "customer_marketing_consents.state": "subscribed, unsubscribed, pending; guarded upserts and per-state checks",
};
