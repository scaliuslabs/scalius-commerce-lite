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
      expect(d1Tables).toHaveLength(119);
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
      expect(retired).toEqual([]);
    } finally {
      d1.close();
      turso.close();
    }
  });
});
