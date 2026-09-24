import { describe, expect, it } from "vitest";

import { collectSourcePolicyViolations, policies, policyViolations } from "./check-source-policies.mjs";
import { browserClosureViolations, coreExportsViolations, crossDomainImportViolations } from "./core-boundaries.mjs";

describe("source policies", () => {
  it("holds for the current tree", () => {
    expect(collectSourcePolicyViolations()).toEqual([]);
  });

  it.each(policies)("catches a sample violation: $rule", (policy) => {
    expect(policyViolations(policy, [{ name: "sample", text: policy.sample }])).not.toEqual([]);
  });

  describe("core domain boundaries", () => {
    const tree = (extra) => new Map([
      ["packages/core/src/modules/a/index.ts", 'export * from "./public";'],
      ["packages/core/src/modules/a/public.ts", "export const shown = 1;"],
      ["packages/core/src/modules/a/internal.ts", "export const hidden = 1;"],
      ["packages/core/src/modules/a/browser.ts", 'export * from "./policy";'],
      ["packages/core/src/modules/a/policy.ts", 'import { z } from "zod";\nexport const schema = z.string();'],
      ...extra,
    ]);

    it("accepts imports of another domain's entries and the files they export", () => {
      expect(crossDomainImportViolations(tree([
        ["packages/core/src/modules/b/b.ts", 'import { shown } from "../a";\nimport { hidden } from "../a/public";\nimport { schema } from "../a/browser";'],
      ]))).toEqual([]);
    });

    it("catches an import of another domain's internal file", () => {
      expect(crossDomainImportViolations(tree([
        ["packages/core/src/modules/b/b.ts", 'import { hidden } from "../a/internal";'],
      ]))).toHaveLength(1);
    });

    it("catches a browser entry that reaches server code", () => {
      expect(browserClosureViolations(tree([]))).toEqual([]);
      expect(browserClosureViolations(tree([
        ["packages/core/src/modules/a/policy.ts", 'import type { Database } from "@scalius/database/client";\nexport type Db = Database;'],
      ]))).toHaveLength(1);
      expect(browserClosureViolations(tree([
        ["packages/core/src/modules/a/policy.ts", 'import type { Hidden } from "./internal";\nexport type Policy = Hidden;'],
      ]))).toHaveLength(1);
    });

    it("catches a deep or wildcard module export and a domain without an entry", () => {
      const domains = new Map([["a", { index: true, browser: true }], ["b", { index: false, browser: false }]]);
      const exportsMap = {
        "./modules/a": "./src/modules/a/index.ts",
        "./modules/a/browser": "./src/modules/a/browser.ts",
        "./modules/*/*": "./src/modules/*/*.ts",
      };
      expect(coreExportsViolations({ exports: exportsMap }, domains)).toEqual([
        expect.stringContaining("./modules/*/*"),
        expect.stringContaining("modules/b has no index.ts"),
        expect.stringContaining("does not export ./modules/b"),
      ]);
    });
  });
});
