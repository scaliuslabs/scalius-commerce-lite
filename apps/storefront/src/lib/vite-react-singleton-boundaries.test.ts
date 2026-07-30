import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontRootPath } from "./test-source-paths";

const REACT_SINGLETON_DEPS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/server",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

describe("storefront Vite React singleton boundaries", () => {
  it("keeps large shared styles cacheable instead of duplicating them in every page", () => {
    const source = readFileSync(storefrontRootPath("astro.config.mjs"), "utf8");

    expect(source).toContain('inlineStylesheets: "auto"');
    expect(source).not.toContain('inlineStylesheets: "always"');
  });

  it("dedupes every React server and JSX entrypoint for dev SSR", () => {
    const source = readFileSync(storefrontRootPath("astro.config.mjs"), "utf8");

    for (const dep of REACT_SINGLETON_DEPS) {
      expect(source).toContain(`"${dep}"`);
    }

    expect(source).toContain("const reactSingletonDeps");
    expect(source).toMatch(/resolve:\s*{[\s\S]*dedupe:\s*reactSingletonDeps/);
    expect(source).not.toMatch(
      /ssr:\s*{[\s\S]*optimizeDeps:\s*{[\s\S]*exclude:\s*reactSingletonDeps/,
    );
  });
});
