import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

const storefrontRoot = [cwd(), join(cwd(), "apps/storefront")].find((candidate) =>
  existsSync(join(candidate, "src/pages/cart.astro")),
);

if (!storefrontRoot) {
  throw new Error("Unable to locate storefront package root for SEO regression tests");
}

describe("storefront SEO regressions", () => {
  it("does not publish cart URLs in the static sitemap", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/sitemap-static.xml.ts"), "utf8");

    expect(source).not.toContain("`${baseUrl}/cart`");
  });

  it("marks the cart page noindex", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/cart.astro"), "utf8");

    expect(source).toContain("noindex");
  });

  it("keeps global OnlineStore JSON-LD behind absolute storefront and logo URLs", async () => {
    const source = await readFile(join(storefrontRoot, "src/layouts/Layout.astro"), "utf8");

    expect(source).toContain("toAbsoluteStorefrontSeoUrl");
    expect(source).toContain("buildOnlineStoreJsonLd");
    expect(source).toContain("buildMerchantReturnPolicyJsonLd");
    expect(source).toContain("const storeSchemaName =");
    expect(source).toMatch(
      /const onlineStoreJsonLd =\s+discoverySettings\.structuredData\.organization && storefrontUrl && logoUrl/,
    );
    expect(source).toContain("const orgJsonLd = onlineStoreJsonLd");
    expect(source).toContain("? serializeJsonForInlineScript(onlineStoreJsonLd)");
    expect(source).toContain("const websiteJsonLd = discoverySettings.structuredData.websiteSearch && storefrontUrl && storeSchemaName");
    expect(source).toContain("business: businessInfo");
    expect(source).toContain("settings: layoutData?.seo?.returnPolicy");
    expect(source).toContain("returnPolicy: merchantReturnPolicyJsonLd");
    expect(source).not.toContain("footerData.copyrightText ||");
    expect(source).not.toContain("headerData.logo.alt ||");
    expect(source).not.toContain("logo: { \"@type\": \"ImageObject\", url: getOptimizedImageUrl");
  });

  it("keeps category and collection breadcrumbs independent from CollectionPage schema", async () => {
    const categorySource = await readFile(
      join(storefrontRoot, "src/pages/categories/[slug].astro"),
      "utf8",
    );
    const collectionSource = await readFile(
      join(storefrontRoot, "src/pages/collections/[id].astro"),
      "utf8",
    );

    expect(categorySource).toContain("const categoryBreadcrumbJsonLd =");
    expect(categorySource).toContain("categorySchemaDescription");
    expect(categorySource).toContain("plainText(category.description)");
    expect(collectionSource).toContain("const collectionBreadcrumbJsonLd =");
    expect(categorySource).not.toContain("breadcrumb: {");
    expect(collectionSource).not.toContain("breadcrumb: {");
  });

  it("keeps OnlineStore sameAs limited to absolute http(s) footer social URLs", async () => {
    const layoutSource = await readFile(
      join(storefrontRoot, "src/layouts/Layout.astro"),
      "utf8",
    );
    const helperSource = await readFile(
      join(storefrontRoot, "src/lib/commerce-structured-data.ts"),
      "utf8",
    );
    const footerSource = await readFile(
      join(storefrontRoot, "src/components/Footer.astro"),
      "utf8",
    );

    expect(layoutSource).toContain("social: footerData.social");
    expect(helperSource).toContain("export function toHttpUrl");
    expect(helperSource).toContain("const parsed = new URL(trimmed)");
    expect(helperSource).toContain(
      'parsed.protocol === "http:" || parsed.protocol === "https:"',
    );
    expect(helperSource).toContain("catch {\n    return null;\n  }");
    expect(helperSource).not.toContain("toAbsoluteStorefrontSeoUrl");
    expect(helperSource).toContain(".map((item) => toHttpUrl(item.url))");
    expect(helperSource).toContain(".filter((url): url is string => Boolean(url))");
    expect(layoutSource).not.toContain(
      ".map((s: { url?: string }) => s.url)\n  .filter(Boolean)",
    );
    expect(
      footerSource.match(/const href = item\.url\.startsWith\("http"\)/g)
        ?.length,
    ).toBe(2);
    expect(footerSource).toContain(": `https://${item.url}`;");
  });

  it("normalizes Open Graph and Twitter images to absolute storefront URLs", async () => {
    const source = await readFile(join(storefrontRoot, "src/layouts/Layout.astro"), "utf8");

    expect(source).toContain("const absoluteOgImageUrl = toAbsoluteStorefrontSeoUrl(ogImage)");
    expect(source).toContain('<meta property="og:image" content={absoluteOgImageUrl}');
    expect(source).toContain('<meta name="twitter:image" content={absoluteOgImageUrl}');
    expect(source).not.toContain('<meta property="og:image" content={ogImage}');
    expect(source).not.toContain('<meta name="twitter:image" content={ogImage}');
  });

  it("keeps sitemap-advertised search canonical and noindexes listing variants", async () => {
    const source = await readFile(join(storefrontRoot, "src/pages/search/index.astro"), "utf8");

    expect(source).toContain('const canonicalUrl = buildAbsoluteStorefrontSeoUrl("/search")');
    expect(source).toContain("canonicalUrl={canonicalUrl ?? undefined}");
    expect(source).toContain("const shouldNoindexSearchPage = Boolean(query) || pagination.page > 1 || sortBy !== \"newest\" || activeFilterCount > 0");
    expect(source).toContain('name="robots" content="noindex,follow"');
  });

  it("uses noindex,follow for public resource indexing controls", async () => {
    const source = await readFile(join(storefrontRoot, "src/layouts/Layout.astro"), "utf8");

    expect(source).toContain('content="noindex,follow"');
    expect(source).not.toContain('content="noindex, nofollow"');
  });
});
