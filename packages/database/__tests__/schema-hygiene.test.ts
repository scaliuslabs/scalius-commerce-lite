import { describe, expect, it } from "vitest";

import { RETIRED_PRE_CONSOLIDATION_TABLES } from "../scripts/normalize-d1-export-core";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "../scripts/sqlite-provider-schema";

describe("canonical schema hygiene", () => {
  it("keeps D1 and Turso on one clean application table set", async () => {
    const d1 = await createProviderSchemaDatabase("d1");
    const turso = await createProviderSchemaDatabase("turso");
    try {
      const d1Tables = readApplicationTableNames(d1);
      const tursoTables = readApplicationTableNames(turso);
      const retired = d1Tables.filter((table) =>
        RETIRED_PRE_CONSOLIDATION_TABLES.has(table));

      expect(d1Tables).toEqual(tursoTables);
      expect(d1Tables).toHaveLength(177);
      // 0116: where the merchant collects tax.
      expect(d1Tables).toContain("tax_regions");
      // 0114: the regions shipping zones serve.
      expect(d1Tables).toContain("delivery_zone_regions");
      // 0113: the customer address book.
      expect(d1Tables).toContain("customer_addresses");
      // 0112: markets, the countries each sells to and their URL presences.
      for (const markets of ["markets", "market_countries", "market_presences"]) expect(d1Tables).toContain(markets);
      // 0110: an app's order.risk hold stops fulfilment until staff release it.
      expect(d1Tables).toContain("order_holds");
      for (const purchasing of ["suppliers", "purchase_orders", "purchase_order_lines", "purchase_order_receipt_lines", "inventory_commands", "inventory_transfers", "inventory_transfer_lines", "inventory_transfer_movements"]) {
        expect(d1Tables).toContain(purchasing);
      }
      for (const marketing of ["customer_marketing_consents", "customer_marketing_consent_events", "customer_tag_links", "customer_segments", "customer_order_stats", "promotion_customer_segments"]) {
        expect(d1Tables).toContain(marketing);
      }
      // The homepage hero is the theme document's hero section (0106).
      expect(d1Tables).not.toContain("hero_sliders");
      expect(d1Tables).not.toContain("hero_sections");
      for (const plugins of ["plugin_installations", "plugin_registrations", "plugin_records", "plugin_kv", "plugin_log_entries", "plugin_event_deliveries", "plugin_cron_runs"]) {
        expect(d1Tables).toContain(plugins);
      }
      expect(d1Tables).toContain("custom_field_definitions");
      expect(d1Tables).toContain("custom_field_values");
      expect(d1Tables).toContain("inventory_locations");
      expect(d1Tables).toContain("inventory_levels");
      for (const events of ["event_outbox", "webhook_subscriptions", "webhook_event_deliveries"]) {
        expect(d1Tables).toContain(events);
      }
      for (const waveB of ["product_reviews", "product_review_stats", "order_review_requests", "digital_assets", "digital_asset_uploads", "digital_entitlements", "digital_licence_keys", "gift_cards", "gift_card_transactions", "warranty_policies", "warranty_policy_revisions", "order_item_warranties", "warranty_claims"]) {
        expect(d1Tables).toContain(waveB);
      }
      expect(d1Tables).toContain("cache_clock");
      expect(d1Tables).toContain("cache_dep");
      expect(d1Tables).toContain("scalius_schema_migrations");
      expect(d1Tables).toContain("cache_generation");
      expect(d1Tables).toContain("agent_grants");
      expect(d1Tables).toContain("agent_artifact_handles");
      expect(d1Tables).toContain("agent_browser_handoffs");
      expect(d1Tables).toContain("agent_storefront_contexts");
      expect(d1Tables).toContain("order_amendments");
      expect(d1Tables).toContain("order_events");
      expect(d1Tables).toContain("admin_identity_handoff_events");
      expect(d1Tables).toContain("order_fulfillments");
      expect(d1Tables).toContain("order_fulfillment_lines");
      expect(d1Tables).toContain("conversations");
      expect(d1Tables).toContain("conversation_messages");
      expect(d1Tables).toContain("conversation_attachments");
      expect(d1Tables).toContain("notification_outbox");
      expect(d1Tables).toContain("notification_delivery_receipts");
      // Replaced in Wave A and dropped by its contract migration (0088).
      for (const dropped of ["order_notification_outbox", "order_notification_delivery_receipts", "order_support_request_events"]) {
        expect(d1Tables).not.toContain(dropped);
      }
      expect(d1Tables).toContain("brands");
      expect(d1Tables).toContain("category_closure");
      expect(d1Tables).toContain("product_facet_values");
      expect(d1Tables).toContain("product_buyer_state");
      expect(d1Tables).toContain("product_content_blocks");
      expect(d1Tables).not.toContain("page_templates");
      expect(retired).toEqual([]);
    } finally {
      d1.close();
      turso.close();
    }
  }, 60_000);
});
