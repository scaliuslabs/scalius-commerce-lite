import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("storefront error pages", () => {
  const notFoundSource = readSource("../pages/404.astro");
  const serverErrorSource = readSource("../pages/500.astro");
  const stateSource = readSource("../components/ErrorPageState.astro");

  it("keeps buyer-facing 404s inside the merchant storefront", () => {
    expect(notFoundSource).toContain('import Layout from "@/layouts/Layout.astro"');
    expect(notFoundSource).toContain('<Layout title="Page not found" noindex>');
    expect(notFoundSource).toContain('primaryLabel="Continue shopping"');
    expect(notFoundSource).toContain('secondaryLabel="Search products"');
    expect(notFoundSource).not.toContain("Go to Homepage");
  });

  it("keeps the 500 fallback independent from layout and API loading", () => {
    expect(serverErrorSource).not.toContain("Layout.astro");
    expect(serverErrorSource).not.toContain("getLayoutData");
    expect(serverErrorSource).toContain("const retryHref");
    expect(serverErrorSource).toContain('primaryLabel="Try again"');
    expect(serverErrorSource).toContain('secondaryLabel="Go to home"');
  });

  it("shares concise responsive actions with mobile-sized targets", () => {
    expect(stateSource).toContain('aria-labelledby="error-page-title"');
    expect(stateSource.match(/min-h-11/g)).toHaveLength(2);
    expect(stateSource).toContain('data-theme-component="button"');
    expect(stateSource).not.toContain("Something Went Wrong");
  });
});
