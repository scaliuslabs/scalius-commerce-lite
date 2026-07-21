import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = existsSync(
  join(process.cwd(), "src/pages/blog/index.astro"),
)
  ? process.cwd()
  : join(process.cwd(), "apps/storefront");
const source = readFileSync(
  join(storefrontRoot, "src/pages/blog/index.astro"),
  "utf8",
);

describe("blog archive presentation", () => {
  it("uses compact text-first cards when an article has no featured image", () => {
    expect(source).toContain("{image && (");
    expect(source).not.toContain(
      '<div class="aspect-video w-full bg-muted" aria-hidden="true" />',
    );
  });

  it("keeps the default archive heading free of generic filler copy", () => {
    expect(source).not.toContain(">Journal<");
    expect(source).toMatch(/\{\s*tag && \(/);
  });
});
