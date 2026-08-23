import { describe, expect, it } from "vitest";

import {
  collectRouteJavaScript,
  validateAdminClientBundle,
} from "./admin-client-bundle-report.mjs";

describe("admin client bundle report", () => {
  it("deduplicates the document, admin shell, and leaf route preload closure", () => {
    const routes = {
      __root__: { preloads: ["/root.js", "/shared.js", "/global.css"] },
      "/admin": { preloads: ["/admin.js", "/shared.js"] },
      "/admin/products/": { preloads: ["/products.js", "/shared.js"] },
    };

    expect(collectRouteJavaScript(routes, "/admin/products/")).toEqual([
      "/admin.js",
      "/products.js",
      "/root.js",
      "/shared.js",
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
