import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const storefrontRoot = existsSync(join(process.cwd(), "src/layouts"))
  ? process.cwd()
  : join(process.cwd(), "apps/storefront");
const layoutSource = readFileSync(
  join(storefrontRoot, "src/layouts/Layout.astro"),
  "utf8",
);
const assistantCssSource = readFileSync(
  join(
    storefrontRoot,
    "src/components/assistant/storefront-assistant.css",
  ),
  "utf8",
);

describe("storefront assistant layout persistence", () => {
  it("mounts the assistant in the shared structural dock with a pre-hydration shell", () => {
    expect(layoutSource).toContain('id="storefront-assistant-layout"');
    expect(layoutSource).toContain('data-assistant-page-slot=""');
    expect(layoutSource).toContain('data-assistant-dock-slot=""');
    expect(layoutSource).toContain("assistantPrehydrateScript");
    expect(layoutSource).toContain("sf-assistant-prehydrate");
    expect(assistantCssSource).toContain(
      'html[data-storefront-assistant-preopen="true"]',
    );
    expect(assistantCssSource).toContain(
      '[data-storefront-assistant-preopen-mode="dock-left"]',
    );
  });

  it("does not enable Astro SPA routing before page scripts are lifecycle-safe", () => {
    // Checkout, order success, payment recovery, product analytics, and product
    // tabs still contain DOMContentLoaded-only initialization. A ClientRouter
    // rollout must first move those initializers to astro:page-load and prove
    // cart/payment listener cleanup across repeated navigation.
    expect(layoutSource).not.toContain("ClientRouter");
    expect(layoutSource).not.toContain("transition:persist");
  });
});
