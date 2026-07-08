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
    expect(source).not.toMatch(/\baddToCart\b/);
    expect(source).not.toMatch(/\bremoveFromCart\b/);
    expect(source).not.toMatch(/\bupdateQuantity\b/);
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
});
