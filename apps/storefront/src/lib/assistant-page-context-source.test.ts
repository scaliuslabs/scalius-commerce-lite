import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("storefront assistant page-context source boundaries", () => {
  const workspaceRoot = process.cwd().endsWith("/apps/storefront")
    ? process.cwd().replace(/\/apps\/storefront$/, "")
    : process.cwd();
  const storefrontSrcRoot = join(workspaceRoot, "apps/storefront/src");

  it("does not directly read private browser storage, cookies, or order APIs", () => {
    const source = readFileSync(
      join(storefrontSrcRoot, "lib/assistant-page-context.client.ts"),
      "utf8",
    );

    expect(source).toContain('from "@/store/cart"');
    expect(source).toContain("__SCALIUS_STOREFRONT_ASSISTANT__");
    expect(source).toContain("getContext");
    expect(source).toContain("navigate");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bXMLHttpRequest\b/);
    expect(source).not.toMatch(/\bnavigator\.sendBeacon\b/);
    expect(source).not.toMatch(/\bindexedDB\b/);
    expect(source).not.toMatch(/\bhydrateCartFromStorage\b/);
    expect(source).not.toMatch(/\baddToCart\b/);
    expect(source).not.toMatch(/\bremoveFromCart\b/);
    expect(source).not.toMatch(/\bupdateQuantity\b/);
    expect(source).not.toMatch(/\bcartStore\.set\b/);
    expect(source).not.toMatch(/\blocalStorage\b/);
    expect(source).not.toMatch(/\bsessionStorage\b/);
    expect(source).not.toMatch(/\bdocument\.cookie\b/);
    expect(source).not.toMatch(/\bcookieStore\b/);
    expect(source).not.toMatch(/order-receipt-cookie/);
    expect(source).not.toMatch(/customer-auth/);
    expect(source).not.toMatch(/checkout\/client/);
  });

  it("keeps the assistant seed on the existing safe inline JSON path", () => {
    const componentSource = readFileSync(
      join(
        storefrontSrcRoot,
        "components/assistant/StorefrontAssistantPageContext.astro",
      ),
      "utf8",
    );
    const layoutSource = readFileSync(
      join(storefrontSrcRoot, "layouts/Layout.astro"),
      "utf8",
    );

    expect(componentSource).toContain("serializeJsonForInlineScript");
    expect(componentSource).not.toContain("JSON.stringify");
    expect(componentSource).not.toMatch(/set:html=\{JSON\.stringify/);
    expect(layoutSource).toContain("<StorefrontAssistantPageContext");
  });

  it("keeps the visible storefront assistant shell local, read-only, and plain text", () => {
    const bubbleSource = readFileSync(
      join(
        storefrontSrcRoot,
        "components/assistant/StorefrontAssistantBubble.tsx",
      ),
      "utf8",
    );
    const layoutSource = readFileSync(
      join(storefrontSrcRoot, "layouts/Layout.astro"),
      "utf8",
    );

    expect(bubbleSource).toContain("STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL");
    expect(bubbleSource).toContain("__SCALIUS_STOREFRONT_ASSISTANT__");
    expect(bubbleSource).toContain("Catalog assistant is not ready");
    expect(bubbleSource).toContain("It cannot complete checkout");
    expect(bubbleSource).not.toMatch(/\bfetch\s*\(/);
    expect(bubbleSource).not.toMatch(/\bXMLHttpRequest\b/);
    expect(bubbleSource).not.toMatch(/\bnavigator\.sendBeacon\b/);
    expect(bubbleSource).not.toMatch(/\bindexedDB\b/);
    expect(bubbleSource).not.toMatch(/\blocalStorage\b/);
    expect(bubbleSource).not.toMatch(/\bsessionStorage\b/);
    expect(bubbleSource).not.toMatch(/\bdocument\.cookie\b/);
    expect(bubbleSource).not.toMatch(/\bcookieStore\b/);
    expect(bubbleSource).not.toMatch(/from ["']@\/store\/cart["']/);
    expect(bubbleSource).not.toMatch(/from ["']@\/lib\/api/);
    expect(bubbleSource).not.toMatch(/\baddToCart\b/);
    expect(bubbleSource).not.toMatch(/\bremoveFromCart\b/);
    expect(bubbleSource).not.toMatch(/\bupdateQuantity\b/);
    expect(bubbleSource).not.toMatch(/\bdangerouslySetInnerHTML\b/);
    expect(bubbleSource).not.toMatch(/\bmarked\b|react-markdown|markdown-it/);
    expect(bubbleSource).not.toMatch(/<form\b|<input\b|<textarea\b/);
    expect(layoutSource).toContain("<StorefrontAssistantBubble client:idle");
  });
});
