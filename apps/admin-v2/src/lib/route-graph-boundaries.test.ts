import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ADMIN_SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stats = statSync(path);
      return stats.isDirectory() ? listSourceFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path));
}

function readProjectFile(path: string) {
  return readFileSync(join(ADMIN_SRC_ROOT, path), "utf8");
}

function hasBroadQueryBarrelImport(source: string) {
  return /from\s+["'][@~]\/lib\/api\.queries["']/.test(source);
}

describe("admin route graph boundaries", () => {
  it("keeps route error UI out of zod-backed list helpers", () => {
    const offenders = listSourceFiles(join(ADMIN_SRC_ROOT, "routes", "admin"))
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ source }) =>
          /import\s+\{[^}]*RouteErrorComponent[^}]*\}\s+from\s+["']~\/lib\/list-helpers["'];/.test(
            source,
          ),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("keeps hot dashboard, settings, and list surfaces off the broad query barrel", () => {
    const protectedFiles = [
      "routes/admin/index.tsx",
      "routes/admin/abandoned-checkouts.tsx",
      "routes/admin/attributes.tsx",
      "routes/admin/categories/index.tsx",
      "routes/admin/collections/index.tsx",
      "routes/admin/customers/index.tsx",
      "routes/admin/discounts/index.tsx",
      "routes/admin/inventory.tsx",
      "routes/admin/orders/index.tsx",
      "routes/admin/pages/index.tsx",
      "routes/admin/products/index.tsx",
      "routes/admin/products/new.tsx",
      "routes/admin/settings/index.tsx",
      "routes/admin/settings/account.tsx",
      "routes/admin/settings/cache.tsx",
      "routes/admin/settings/checkout.tsx",
      "routes/admin/settings/delivery-providers.tsx",
      "routes/admin/settings/fraud-checker.tsx",
      "routes/admin/settings/hero-sliders.tsx",
      "routes/admin/settings/meta-conversion.tsx",
      "routes/admin/settings/notifications.tsx",
      "routes/admin/settings/theme.tsx",
      "components/admin/AbandonedCheckoutsManager.tsx",
      "components/admin/CacheManager.tsx",
      "components/admin/InventoryManager.tsx",
      "components/admin/delivery-locations/hooks/useDeliveryLocations.ts",
      "components/admin/order-list/BulkShipDialog.tsx",
      "components/admin/shipping-methods/hooks/useShippingMethods.ts",
    ];

    const offenders = protectedFiles.filter((path) =>
      hasBroadQueryBarrelImport(readProjectFile(path)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps narrow query-option modules from depending on the broad query barrel", () => {
    const offenders = listSourceFiles(join(ADMIN_SRC_ROOT, "lib", "api-query-options"))
      .map((path) => ({
        path: relative(ADMIN_SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ source }) => /api\.queries/.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
