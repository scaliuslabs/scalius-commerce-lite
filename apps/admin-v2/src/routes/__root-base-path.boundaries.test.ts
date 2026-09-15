import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./__root.tsx", import.meta.url), "utf8");

describe("dashboard base path propagation to the browser", () => {
  it("renders the runtime base path as a meta tag the client reads before hydration", () => {
    // The client cannot read the Worker env, so the base path reaches it only
    // through this tag. It must be produced by head(), not by a component,
    // so it exists in the first byte of HTML the browser parses.
    const head = source.slice(source.indexOf("head: ()"), source.indexOf("scripts:"));
    expect(head).toContain("const basePath = getDashboardBasePath();");
    expect(head).toContain("{ name: DASHBOARD_BASE_PATH_META_NAME, content: basePath }");
  });

  it("routes its own document assets through the same prefix", () => {
    expect(source).toContain('prefixDashboardBasePath(basePath, appCss)');
    expect(source).toContain('prefixDashboardBasePath(basePath, "/favicon.png")');
    // A bare root-relative asset href would 404 below a prefix.
    expect(source).not.toMatch(/href:\s*"\/favicon\.png"/);
    expect(source).not.toMatch(/href:\s*appCss\b/);
  });
});
