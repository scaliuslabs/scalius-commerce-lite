import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectShellEntries,
  collectStaticClosure,
  validateAdminClientBundle,
} from "./admin-client-bundle-report.mjs";

const asset = (name) => resolve("/virtual-admin-assets", name);

describe("admin client bundle report", () => {
  it("reads module entries and modulepreloads from the SPA shell, not styles or inline scripts", () => {
    expect(collectShellEntries(`
      <script>document.documentElement.style.colorScheme="light"</script>
      <script type="module" crossorigin src="/assets/immutable/index-a1B2c3D4.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/immutable/runtime-a1B2c3D4.js">
      <link rel="stylesheet" crossorigin href="/assets/immutable/index-a1B2c3D4.css">
    `)).toEqual([
      "/assets/immutable/index-a1B2c3D4.js",
      "/assets/immutable/runtime-a1B2c3D4.js",
    ]);
  });

  it("follows static chunk imports and leaves lazy route chunks out", () => {
    const sources = new Map([
      [asset("index.js"), 'import{a}from"./shared.js";const route=()=>import("./route.js");'],
      [asset("shared.js"), 'import"./runtime.js";export const a=1;'],
      [asset("runtime.js"), "export {};"],
      [asset("route.js"), 'import{a}from"./shared.js";'],
    ]);

    expect(collectStaticClosure([asset("index.js")], (file) => sources.get(file))).toEqual([
      asset("index.js"),
      asset("runtime.js"),
      asset("shared.js"),
    ]);
  });

  it("fails budgets and heavy-module leaks independently", () => {
    const failures = validateAdminClientBundle([
      {
        label: "Products",
        files: ["/assets/immutable/html2pdf-example.js", "/products.js"],
        maxJavaScript: 1,
        maxBrotliKiB: 1,
        brotliBytes: 2 * 1024,
      },
    ]);

    expect(failures).toEqual([
      "Products has 2 JavaScript assets (budget 1)",
      "Products is 2.0 KiB Brotli (budget 1 KiB)",
      "Products eagerly loads heavy lazy chunk html2pdf-example.js",
    ]);
  });
});
