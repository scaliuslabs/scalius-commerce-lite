import { describe, expect, it } from "vitest";

import { collectSourcePolicyViolations, physicalUtilityViolations, policies, policyViolations } from "./check-source-policies.mjs";
import {
  browserClosureViolations,
  coreExportsViolations,
  crossDomainImportViolations,
  crossUnitCycleViolations,
} from "./core-boundaries.mjs";

describe("source policies", () => {
  it("holds for the current tree", () => {
    expect(collectSourcePolicyViolations()).toEqual([]);
  });

  it.each(policies)("catches a sample violation: $rule", (policy) => {
    expect(policyViolations(policy, [{ name: "sample", text: policy.sample }])).not.toEqual([]);
  });

  it("catches physical side utilities, but not logical ones, rtl/ltr pairs or allowed positions", () => {
    const text = [
      '<div className={cn("ml-2 md:pr-4 ms-2 pe-4 inset-s-0 text-start", open && "border-l")}>left and right</div>',
      'const corner = "rounded-tl-lg rtl:left-0 ltr:right-0";',
      '<span class="sm:left-1/2 -translate-x-1/2 left-(--tip-x)">',
      "// A comment may say ml-2.",
    ].join("\n");
    expect(physicalUtilityViolations([{ name: "a.tsx", text }], { "a.tsx": ["left-1/2"] })).toEqual([
      "a.tsx:1: ml-2",
      "a.tsx:1: md:pr-4",
      "a.tsx:1: border-l",
      "a.tsx:2: rounded-tl-lg",
      "a.tsx:3: left-(--tip-x)",
    ]);
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

    it("accepts imports of another domain's entries", () => {
      expect(crossDomainImportViolations(tree([
        ["packages/core/src/modules/b/b.ts", 'import { shown } from "../a";\nimport { schema } from "../a/browser";'],
        ["packages/core/src/integrations/c.ts", 'import { shown } from "../modules/a";'],
      ]))).toEqual([]);
    });

    it("catches a deep import of a file the entry exports, from a domain or a shared area", () => {
      expect(crossDomainImportViolations(tree([
        ["packages/core/src/modules/b/b.ts", 'import { shown } from "../a/public";'],
        ["packages/core/src/integrations/c.ts", 'import { shown } from "../modules/a/public";'],
      ]))).toHaveLength(2);
    });

    it("catches an import cycle that leaves a unit", () => {
      const acyclic = tree([
        ["packages/core/src/modules/b/index.ts", 'import { shown } from "../a";\nexport const b = shown;'],
      ]);
      expect(crossUnitCycleViolations(acyclic)).toEqual([]);
      expect(crossUnitCycleViolations(tree([
        ["packages/core/src/modules/a/public.ts", 'import { c } from "../../integrations/c";\nexport const shown = c;'],
        ["packages/core/src/integrations/c.ts", 'import { shown } from "../modules/a";\nexport const c = 1;'],
      ]))).toEqual([expect.stringContaining("import cycle across @integrations/c, a")]);
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
