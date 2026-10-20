import { describe, expect, it } from "vitest";

import { ruleSelection } from "./test-affected.mjs";
import { passesFor } from "./test-runner.mjs";

const TESTS = [
  "apps/api/src/cache-dvc.property.test.ts",
  "apps/api/src/cache-dvc.race.test.ts",
  "apps/api/src/cache-deps-catalogue.test.ts",
  "apps/api/src/plugins/routes.test.ts",
  "apps/api/src/openapi/stable-operations.test.ts",
  "apps/storefront/src/lib/cart.test.ts",
  "packages/core/src/modules/orders/order-create.d1.test.ts",
  "packages/core/src/modules/orders/order-math.test.ts",
  "packages/database/__tests__/markets-migration.test.ts",
  "packages/database/__tests__/cache-dep-triggers.test.ts",
  "packages/plugin-sdk/src/testing-contract.test.ts",
  "packages/shared/src/plugins/abi.snapshot.test.ts",
  "packages/cli/test/finalized-contract.test.ts",
];

describe("test:affected path rules", () => {
  it("selects the database tests and the DVC gate for a migration-only change", () => {
    const { all, files, rules } = ruleSelection(["packages/database/migrations/0166_new.sql"], TESTS);
    expect(all).toBe(false);
    expect(rules).toEqual(["migrations"]);
    expect(files).toEqual(expect.arrayContaining([
      "packages/database/__tests__/markets-migration.test.ts",
      "packages/core/src/modules/orders/order-create.d1.test.ts",
      "apps/api/src/cache-dvc.property.test.ts",
    ]));
    expect(files).not.toContain("packages/core/src/modules/orders/order-math.test.ts");
    expect(files).not.toContain("apps/storefront/src/lib/cart.test.ts");
  });

  it("selects the DVC gate for the dependency registry and the trigger generators", () => {
    for (const changed of ["packages/shared/src/cache-deps.ts", "packages/database/scripts/cache-dep-triggers.ts", "packages/database/scripts/event-outbox-triggers.ts"]) {
      const { files } = ruleSelection([changed], TESTS);
      expect(files).toEqual(expect.arrayContaining([
        "apps/api/src/cache-dvc.property.test.ts",
        "apps/api/src/cache-dvc.race.test.ts",
        "packages/database/__tests__/cache-dep-triggers.test.ts",
      ]));
    }
  });

  it("selects the plugin tests for a manifest or ABI change, and the contract tests for a generated contract", () => {
    expect(ruleSelection(["packages/shared/src/plugins/manifest.ts"], TESTS).files).toEqual(expect.arrayContaining([
      "packages/shared/src/plugins/abi.snapshot.test.ts",
      "packages/plugin-sdk/src/testing-contract.test.ts",
      "apps/api/src/plugins/routes.test.ts",
    ]));
    expect(ruleSelection(["apps/api/src/generated/agent-operations.gen.txt"], TESTS).files).toEqual(expect.arrayContaining([
      "packages/cli/test/finalized-contract.test.ts",
      "apps/api/src/openapi/stable-operations.test.ts",
    ]));
  });

  it("runs everything when the test setup changes, and a changed test file always runs", () => {
    expect(ruleSelection(["vitest.config.ts"], TESTS).all).toBe(true);
    expect(ruleSelection(["packages/database/src/testing/migrated-image-setup.ts"], TESTS).all).toBe(true);
    expect(ruleSelection(["apps/storefront/src/lib/cart.test.ts"], TESTS).files).toEqual(["apps/storefront/src/lib/cart.test.ts"]);
    expect(ruleSelection(["apps/storefront/src/lib/cart.ts"], TESTS)).toEqual({ all: false, files: [], rules: [] });
  });
});

describe("test runner passes", () => {
  it("starts only the pass that owns the filtered files", () => {
    expect(passesFor([])).toEqual({ parallel: true, serial: true });
    expect(passesFor(["--reporter=dot"])).toEqual({ parallel: true, serial: true });
    expect(passesFor(["apps/api/src/cache-dvc.race.test.ts"])).toEqual({ parallel: true, serial: false });
    expect(passesFor(["packages/database/__tests__/turso-upload-bundle.test.ts"])).toEqual({ parallel: false, serial: true });
    expect(passesFor(["packages/database/"])).toEqual({ parallel: true, serial: true });
    expect(passesFor(["-t", "a/b", "scripts/dev-sh.test.mjs"])).toEqual({ parallel: true, serial: false });
  });
});
