// Foreign-key child columns. SQLite (D1 enforces foreign keys) checks a
// parent row's delete by looking its key up in every child table, and a
// child column with no index it can seek makes that a full scan per deleted
// parent row; a code read by the column scans the same way. Every such
// column is indexed (0169 added the last ones a code path uses) or listed
// here with why it is not: an index costs every write of its table, and D1
// bills a written row a thousand times a read one.
import { describe, expect, it } from "vitest";

import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const INVITATION_REVOKE = "The user parent is hard-deleted only when a pending invitation is revoked (that user wrote no rows): a rare staff action, while an index would cost every staff-attributed write.";
const STAFF_SCALE = "Bounded by the staff count, and the user parent is hard-deleted only when a pending invitation is revoked.";
const NEVER_DELETED = "The parent is never hard-deleted and no code reads by this column.";
const LOCATION = "Inventory locations are never hard-deleted; the only read is an optional admin filter of a ledger written on every stock change.";
const TAX_CLASS = "Tax classes are soft-deleted; the delete guard's NOT EXISTS reads once per deleted class, while an index would cost catalog writes.";
const AGENT_CREDENTIAL = "Short-lived rows (they expire); a credential is deleted only with its revoked grant, and every read also matches the row id.";

const UNINDEXED: Readonly<Record<string, string>> = {
  "admin_invitations.invited_by_user_id": STAFF_SCALE,
  "admin_setup_claims.completed_user_id": STAFF_SCALE,
  "agent_artifact_handles.credential_id": AGENT_CREDENTIAL,
  "agent_authorization_requests.decided_by_user_id": STAFF_SCALE,
  "agent_browser_handoffs.credential_id": AGENT_CREDENTIAL,
  "agent_device_authorizations.approved_by_user_id": STAFF_SCALE,
  "agent_grants.revoked_by_user_id": STAFF_SCALE,
  "conversation_saved_replies.created_by": STAFF_SCALE,
  "conversation_saved_replies.updated_by": STAFF_SCALE,
  "conversation_search_terms.message_id": NEVER_DELETED,
  "digital_entitlements.fulfillment_id": "Fulfillments are never hard-deleted; the one read by it also matches the order (digital_entitlements_order_idx).",
  "gift_card_transactions.refund_attempt_id": NEVER_DELETED,
  "gift_cards.issued_by_user_id": INVITATION_REVOKE,
  "gift_cards.source_refund_attempt_id": "Refund attempts are never hard-deleted; the read by it matches source = 'refund' (gift_cards_refund_attempt_unique).",
  "inventory_movements.location_id": LOCATION,
  "inventory_transfer_movements.location_id": LOCATION,
  "inventory_transfer_movements.operation_key": NEVER_DELETED,
  "invoice_issue_commands.invoice_id": NEVER_DELETED,
  "media_upload_sessions.folder_id": NEVER_DELETED,
  "order_discount_allocations.effect_id": NEVER_DELETED,
  "order_discount_allocations.order_item_id": "Written by every discounted checkout; the only order-line delete is an amendment, which refuses an order with allocations (orders/admin/amend.ts).",
  "order_events.actor_id": INVITATION_REVOKE,
  "order_fulfillments.location_id": LOCATION,
  "order_holds.released_by": INVITATION_REVOKE,
  "order_item_warranties.revision_id": NEVER_DELETED,
  "order_items.warranty_revision_id": NEVER_DELETED,
  "order_return_receipt_lines.restock_location_id": LOCATION,
  "order_return_receipt_lines.return_line_id": NEVER_DELETED,
  "plugin_installations.activated_by": STAFF_SCALE,
  "plugin_installations.installed_by": STAFF_SCALE,
  "product_channel_publications.channel_id": "A channel is deleted only when its app is uninstalled (one check per channel); reads go through the published-row channel index.",
  "product_reviews.reply_user_id": INVITATION_REVOKE,
  "product_variants.tax_class_id": TAX_CLASS,
  "products.tax_class_id": TAX_CLASS,
  "purchase_order_receipt_lines.location_id": LOCATION,
  "purchase_order_receipt_lines.operation_key": NEVER_DELETED,
  "push_subscriptions.user_id": STAFF_SCALE,
  "tax_settings.default_tax_class_id": "One settings row.",
  "tax_settings.shipping_tax_class_id": "One settings row.",
  "user_permissions.assigned_by": STAFF_SCALE,
  "user_roles.assigned_by": STAFF_SCALE,
  "webhook_subscriptions.created_by": STAFF_SCALE,
};

describe("foreign-key child indexes", () => {
  it("indexes every foreign-key child column except the listed ones", () => {
    const sqlite = createMigratedSqlite();
    try {
      const tables = (sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL%'",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      const scanned: string[] = [];
      for (const table of tables) {
        const keys = new Map<number, string[]>();
        for (const row of sqlite.prepare("SELECT id, seq, \"from\" AS column FROM pragma_foreign_key_list(?) ORDER BY id, seq").all(table) as Array<{ id: number; column: string }>) {
          keys.set(row.id, [...(keys.get(row.id) ?? []), row.column]);
        }
        for (const columns of keys.values()) {
          // The lookup a parent delete runs: equality on every child column.
          const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM "${table}" WHERE ${columns.map((column) => `"${column}" = ?`).join(" AND ")}`)
            .all(...columns.map(() => "x")) as Array<{ detail: string }>).map((row) => row.detail);
          if (plan.some((detail) => detail.startsWith("SCAN"))) scanned.push(`${table}.${columns.join("+")}`);
        }
      }
      expect(scanned.sort()).toEqual(Object.keys(UNINDEXED).sort());
    } finally {
      sqlite.close();
    }
  });
});
