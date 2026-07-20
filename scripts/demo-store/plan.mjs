import { demoStoreManifest } from "./manifest.mjs";
import { assertValidDemoStoreManifest } from "./validate.mjs";

export const DEMO_STORE_PHASES = Object.freeze([
  "snapshot-current-state",
  "resolve-media",
  "reconcile-vocabulary",
  "reconcile-categories",
  "reconcile-products",
  "reconcile-collections",
  "reconcile-presentation",
  "verify-merchant-and-buyer-flows",
]);

export function buildDemoStorePlan(manifest = demoStoreManifest) {
  const summary = assertValidDemoStoreManifest(manifest);
  return {
    mode: "plan",
    writesEnabled: false,
    schemaVersion: manifest.schemaVersion,
    store: manifest.store,
    summary,
    phases: DEMO_STORE_PHASES.map((name, index) => ({
      index,
      name,
      resumeKey: `v${manifest.schemaVersion}:${String(index).padStart(2, "0")}:${name}`,
    })),
    retainedResources: manifest.products
      .filter((product) => product.retainedProductId)
      .map((product) => ({ slug: product.slug, productId: product.retainedProductId })),
  };
}

export function formatDemoStorePlan(plan) {
  const s = plan.summary;
  return [
    `${plan.store.name} demo-store plan (schema v${plan.schemaVersion})`,
    `Writes: disabled`,
    `Catalog: ${s.categories} categories · ${s.products} products · ${s.skus} SKUs`,
    `Topology: ${s.optionedProducts} optioned · ${s.simpleProducts} simple · 10 products per category`,
    `Media intent: ${s.productMediaSlots} product slots · ${s.presentationMediaSlots} presentation slots · ${s.mediaSlots} total`,
    `Content: ${s.additionalSections} additional sections across ${s.productsWithTwoOrMoreSections} richly sectioned products`,
    `Merchandising: ${s.collections} collections · ${s.offers} active offers · ${s.heroes} hero stories`,
    `Retained: ${plan.retainedResources.map((item) => `${item.slug} (${item.productId})`).join(", ")}`,
    `Resume phases: ${plan.phases.length} stable keys`,
    `Validation: passed`,
  ].join("\n");
}
