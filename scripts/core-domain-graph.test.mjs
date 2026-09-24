import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { domainCycles, domainEdges, readCoreSources } from "./core-boundaries.mjs";

const allow = JSON.parse(readFileSync(new URL("./core-domain-graph.allow.json", import.meta.url), "utf8"));
const edges = domainEdges(readCoreSources());

describe("core domain dependency graph", () => {
  it("adds no domain dependency beyond the reviewed allowlist", () => {
    expect([...edges.keys()].filter((edge) => !allow.edges.includes(edge)).sort()).toEqual([]);
  });

  it("drops allowlisted dependencies the code no longer has, so the graph only shrinks", () => {
    expect(allow.edges.filter((edge) => !edges.has(edge))).toEqual([]);
  });

  it("documents every dependency cycle the allowlist permits", () => {
    expect(domainCycles(edges)).toEqual(allow.cycles);
  });

  it("sees a new cross-domain import in a sample tree", () => {
    const sample = new Map([
      ["packages/core/src/modules/a/index.ts", 'export * from "./a";'],
      ["packages/core/src/modules/a/a.ts", 'import { b } from "../b";\nexport const a = b;'],
      ["packages/core/src/modules/b/index.ts", 'export const b = 1;'],
    ]);
    expect([...domainEdges(sample).keys()]).toEqual(["a -> b"]);
    sample.set("packages/core/src/modules/b/index.ts", 'import { a } from "../a";\nexport const b = a;');
    expect(domainCycles(domainEdges(sample))).toEqual([["a", "b"]]);
  });
});
