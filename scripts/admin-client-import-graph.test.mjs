import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { findStaticImportCycles } from "./admin-client-import-graph.mjs";

const asset = (name) => resolve("/virtual-admin-assets", name);

describe("admin client static import graph", () => {
  it("detects a minified reciprocal chunk import", () => {
    const sources = new Map([
      [asset("admin-shell-a.js"), 'import{i as e}from"./admin-shell-b.js";export{e};'],
      [asset("admin-shell-b.js"), 'import{e as n}from"./admin-shell-a.js";export{n};'],
    ]);

    expect(findStaticImportCycles(sources)).toHaveLength(1);
  });

  it("accepts an acyclic graph and ignores lazy imports", () => {
    const sources = new Map([
      [asset("entry.js"), 'import{a}from"./shared.js";const lazy=()=>import("./route.js");'],
      [asset("shared.js"), "export const a=1;"],
      [asset("route.js"), 'import{a}from"./shared.js";export{a};'],
    ]);

    expect(findStaticImportCycles(sources)).toEqual([]);
  });
});
