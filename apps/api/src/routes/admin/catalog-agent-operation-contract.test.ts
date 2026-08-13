import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeFiles = ["products", "categories", "attributes", "collections", "inventory"] as const;
const sources = Object.fromEntries(routeFiles.map((name) => [
  name,
  readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"),
]));
const allSource = Object.values(sources).join("\n");

const operationClassifications = {
  read: [
    "dashboard.products.stats",
    "dashboard.products.lookup_barcode",
    "dashboard.products.list",
    "dashboard.products.get_by_ids",
    "dashboard.products.get",
    "dashboard.products.get_section",
    "dashboard.product_variants.list",
    "dashboard.categories.form_options",
    "dashboard.categories.list",
    "dashboard.categories.publish_readiness",
    "dashboard.categories.get",
    "dashboard.attributes.list",
    "dashboard.attribute_values.list",
    "dashboard.collections.form_options",
    "dashboard.collections.category_options",
    "dashboard.collections.product_options",
    "dashboard.collections.list",
    "dashboard.collections.get_by_ids",
    "dashboard.collections.get",
    "dashboard.inventory.list",
    "dashboard.inventory.movements_export",
    "dashboard.inventory_alerts.list",
    "dashboard.inventory_labels.preview",
    "dashboard.inventory_labels.generate_artifact",
    "dashboard.inventory.lookup_sku",
  ],
  write: [
    "dashboard.products.create",
    "dashboard.products.update",
    "dashboard.products.update_section",
    "dashboard.products.restore",
    "dashboard.product_variants.create",
    "dashboard.product_variants.update",
    "dashboard.product_options.save_matrix",
    "dashboard.categories.create",
    "dashboard.categories.bulk_restore",
    "dashboard.categories.update",
    "dashboard.categories.set_status",
    "dashboard.categories.restore",
    "dashboard.attributes.create",
    "dashboard.attributes.update",
    "dashboard.attributes.bulk_restore",
    "dashboard.attributes.restore",
    "dashboard.attribute_values.create",
    "dashboard.attribute_values.rename",
    "dashboard.collections.create",
    "dashboard.collections.bulk_activate",
    "dashboard.collections.bulk_deactivate",
    "dashboard.collections.bulk_restore",
    "dashboard.collections.restore",
    "dashboard.collections.reorder",
    "dashboard.collections.update",
    "dashboard.inventory_alerts.acknowledge",
    "dashboard.inventory.adjust",
    "dashboard.inventory.adjust_stock",
    "dashboard.inventory.set_stock",
  ],
  destructive: [
    "dashboard.products.bulk_delete",
    "dashboard.products.trash",
    "dashboard.products.delete_permanently",
    "dashboard.product_variants.retire",
    "dashboard.categories.bulk_delete",
    "dashboard.categories.trash",
    "dashboard.categories.delete_permanently",
    "dashboard.attributes.trash",
    "dashboard.attributes.delete_permanently",
    "dashboard.attributes.bulk_delete",
    "dashboard.attribute_values.delete",
    "dashboard.collections.bulk_delete",
    "dashboard.collections.trash",
    "dashboard.collections.delete_permanently",
  ],
} as const;

const revisionRequired = new Set([
  "dashboard.products.bulk_delete",
  "dashboard.products.update",
  "dashboard.products.update_section",
  "dashboard.products.trash",
  "dashboard.products.restore",
  "dashboard.products.delete_permanently",
  "dashboard.product_variants.create",
  "dashboard.product_variants.update",
  "dashboard.product_variants.retire",
  "dashboard.product_options.save_matrix",
  "dashboard.categories.bulk_delete",
  "dashboard.categories.bulk_restore",
  "dashboard.categories.update",
  "dashboard.categories.set_status",
  "dashboard.categories.trash",
  "dashboard.categories.delete_permanently",
  "dashboard.categories.restore",
  "dashboard.collections.reorder",
  "dashboard.collections.update",
]);

const idempotencyRequired = new Set([
  "dashboard.inventory.adjust",
  "dashboard.inventory.adjust_stock",
  "dashboard.inventory.set_stock",
]);

const scenarioInventory = {
  productLifecycleAndHistoryGuard: [
    "dashboard.products.create",
    "dashboard.products.get",
    "dashboard.products.get_section",
    "dashboard.products.update",
    "dashboard.products.update_section",
    "dashboard.products.trash",
    "dashboard.products.restore",
    "dashboard.products.delete_permanently",
  ],
  optionAxesSkuIdentityAndRetirement: [
    "dashboard.product_options.save_matrix",
    "dashboard.product_variants.create",
    "dashboard.product_variants.list",
    "dashboard.product_variants.update",
    "dashboard.product_variants.retire",
  ],
  categoryMonotonicLifecycle: [
    "dashboard.categories.update",
    "dashboard.categories.set_status",
    "dashboard.categories.trash",
    "dashboard.categories.restore",
    "dashboard.categories.delete_permanently",
  ],
  attributeValues: [
    "dashboard.attributes.update",
    "dashboard.attribute_values.list",
    "dashboard.attribute_values.create",
    "dashboard.attribute_values.rename",
    "dashboard.attribute_values.delete",
  ],
  collectionMembershipStatusAndOrder: [
    "dashboard.collections.update",
    "dashboard.collections.bulk_activate",
    "dashboard.collections.bulk_deactivate",
    "dashboard.collections.reorder",
  ],
  inventoryCasLedgerAndPublicAvailability: [
    "dashboard.inventory.adjust",
    "dashboard.inventory.adjust_stock",
    "dashboard.inventory.set_stock",
  ],
  boundedServerLabelArtifacts: [
    "dashboard.inventory_labels.preview",
    "dashboard.inventory_labels.generate_artifact",
  ],
  boundedMovementArtifacts: [
    "dashboard.inventory.movements_export",
  ],
} as const;

describe("dashboard catalog agent operation identity", () => {
  it("pins a stable operation ID on every catalog and inventory route", () => {
    for (const [name, source] of Object.entries(sources)) {
      const routes = source.match(/createRoute\(\{/g) ?? [];
      const operationIds = source.match(/operationId:\s*"dashboard\.[a-z0-9_]+\.[a-z0-9_]+"/g) ?? [];
      expect(operationIds, name).toHaveLength(routes.length);
    }
  });

  it("classifies every operation exactly once by its highest semantic risk", () => {
    const routeOperationIds = allSource.match(/operationId:\s*"(dashboard\.[a-z0-9_]+\.[a-z0-9_]+)"/g)
      ?.map((match) => match.match(/"([^"]+)"/)![1]!) ?? [];
    const classified = Object.values(operationClassifications).flat();

    expect(routeOperationIds).toHaveLength(68);
    expect(new Set(routeOperationIds).size).toBe(routeOperationIds.length);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...routeOperationIds].sort());
  });

  it("keeps caller-supplied concurrency and retry claims narrow and explicit", () => {
    expect(revisionRequired.size).toBe(19);
    expect(idempotencyRequired).toEqual(new Set([
      "dashboard.inventory.adjust",
      "dashboard.inventory.adjust_stock",
      "dashboard.inventory.set_stock",
    ]));
    for (const operationId of [...revisionRequired, ...idempotencyRequired]) {
      expect(allSource, operationId).toContain(`operationId: "${operationId}"`);
    }
  });

  it("pins scenario parity to semantic operations instead of UI annotations", () => {
    expect(Object.keys(scenarioInventory)).toHaveLength(8);
    for (const operationIds of Object.values(scenarioInventory)) {
      for (const operationId of operationIds) {
        expect(allSource, operationId).toContain(`operationId: "${operationId}"`);
      }
    }
  });

  it("keeps identity, revision, bounded lookup, ledger and artifact guards visible at the HTTP seam", () => {
    expect(sources.products).toContain("expectedAggregateRevision");
    expect(sources.products).toContain('path: "/{id}/sections/{section}"');
    expect(sources.products).toContain("productSemanticSectionQuerySchema");
    expect(sources.products).toContain("productSemanticSectionPatchSchema");
    expect(sources.products).toContain("dashboard.product_options.save_matrix");
    expect(sources.categories).toContain("expectedRevision");
    expect(sources.collections).toContain("expectedVersion");
    expect(sources.inventory).toContain("INVENTORY_LABEL_VARIANT_LIMIT");
    expect(sources.inventory).toContain("INVENTORY_LABEL_ARTIFACT_MAX_COPIES");
    expect(sources.inventory).toContain("operationKey");
    expect(sources.inventory).toContain("invalidateStockMutationIfVisible");
    expect(sources.inventory).toContain('path: "/labels/artifact"');
    expect(sources.inventory).toContain('path: "/movements/export"');
    expect(sources.inventory).not.toContain('format: z.enum(["json", "csv"])');
    expect(sources.inventory).toContain('"Cache-Control", "private, no-store"');
  });
});
