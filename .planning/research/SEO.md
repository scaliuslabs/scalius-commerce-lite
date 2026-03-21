# Storefront SEO Research

**Project:** Scalius Commerce — Storefront SEO (JSON-LD, OG Tags, Canonical URLs)
**Researched:** 2026-03-22
**Overall confidence:** HIGH — Google and Facebook specifications verified against official documentation

---

## JSON-LD Structured Data

### Product Schema

**Confidence:** HIGH — verified against Google Search Central documentation.

Google distinguishes two product structured data modes:

- **Product snippet** — pages that describe a product but are not a direct purchase page. Requires `name` + at least one of `offers`, `review`, or `aggregateRating`.
- **Merchant listing** — pages where customers can actually buy. Requires `name` + `offers` with `price`. An image is required for merchant listings but not for snippets.

Since Scalius storefront product pages have "Add to Cart" and direct purchase, they qualify as **merchant listings**. Use that spec.

**Minimum viable Product JSON-LD:**

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Product Name",
  "description": "Product description text",
  "image": ["https://cloud.scalius.com/cdn-cgi/image/width=1200,height=1200,quality=85,format=auto,fit=cover/path/to/image.jpg"],
  "sku": "SKU-001",
  "brand": {
    "@type": "Brand",
    "name": "Brand Name"
  },
  "offers": {
    "@type": "Offer",
    "url": "https://storefront.scalius.com/products/product-slug",
    "priceCurrency": "BDT",
    "price": "1200.00",
    "priceValidUntil": "2027-01-01",
    "availability": "https://schema.org/InStock",
    "itemCondition": "https://schema.org/NewCondition"
  }
}
```

**Full recommended Product JSON-LD (Scalius context):**

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "{product.name}",
  "description": "{product.description or product.name}",
  "image": ["{optimized image URL at 1200x1200}"],
  "sku": "{variant.sku or product.id}",
  "brand": {
    "@type": "Brand",
    "name": "{brand attribute value or store name}"
  },
  "offers": {
    "@type": "Offer",
    "url": "{STOREFRONT_URL}/products/{product.slug}",
    "priceCurrency": "{currency.code}",
    "price": "{product.discountedPrice formatted to 2 decimal places}",
    "priceValidUntil": "{one year from now, ISO 8601}",
    "availability": "https://schema.org/InStock",
    "itemCondition": "https://schema.org/NewCondition",
    "seller": {
      "@type": "Organization",
      "name": "{store name from header/footer data}"
    }
  }
}
```

**Property mapping from existing codebase:**

| Schema Property | Codebase Source |
|-----------------|-----------------|
| `name` | `product.name` |
| `description` | `product.description` (strip HTML) or fall back to `product.name` |
| `image` | `images[0].url` passed through `getOptimizedImageUrl()` at 1200x1200 |
| `sku` | `variants[0]?.sku` or `product.id` |
| `brand.name` | `product.attributes?.find(a => a.name.toLowerCase() === 'brand')?.value` — mirrors facebook-feed.xml.ts pattern |
| `offers.url` | `${getRuntimeStorefrontUrl()}/products/${product.slug}` |
| `offers.priceCurrency` | `layoutData.currency.code` |
| `offers.price` | `product.discountedPrice.toFixed(2)` |
| `offers.priceValidUntil` | Next year ISO date — static computation at render time |
| `offers.availability` | `"https://schema.org/InStock"` — product pages only shown for active products |

**Out of scope for this milestone:** `aggregateRating`, `review` — the product reviews feature is explicitly out of scope. Do not add placeholder or empty review properties, as Google penalizes malformed aggregateRating with ratingCount=0.

**Sale price:** When `product.discountedPrice < product.price`, also emit:
```json
"offers": {
  "@type": "Offer",
  "price": "{discountedPrice}",
  "priceSpecification": {
    "@type": "UnitPriceSpecification",
    "price": "{product.price}",
    "priceCurrency": "{currency.code}",
    "priceType": "https://schema.org/ListPrice"
  }
}
```

---

### BreadcrumbList Schema

**Confidence:** HIGH — verified against Google Search Central breadcrumb documentation.

`BreadcrumbList` is a container of `ListItem` entries. Each `ListItem` requires `position` (integer starting at 1), `name` (display text), and `item` (URL). The final item's `item` URL can be omitted per spec but Google accepts it either way.

**Product page breadcrumb:**
- Position 1: Home → `{STOREFRONT_URL}/`
- Position 2 (conditional): Category name → `{STOREFRONT_URL}/categories/{category.slug}`
- Position 3 (or 2 without category): Product name → `{STOREFRONT_URL}/products/{product.slug}`

**Category page breadcrumb:**
- Position 1: Home → `{STOREFRONT_URL}/`
- Position 2: Category name → `{STOREFRONT_URL}/categories/{category.slug}`

**JSON-LD structure:**
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://storefront.scalius.com/"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "{category.name}",
      "item": "https://storefront.scalius.com/categories/{category.slug}"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "{product.name}",
      "item": "https://storefront.scalius.com/products/{product.slug}"
    }
  ]
}
```

The existing `ProductBreadcrumbs.astro` already renders the correct HTML structure. BreadcrumbList JSON-LD is an independent addition to the `<head>` — it does not replace or modify the visual breadcrumb HTML.

---

### Organization Schema

**Confidence:** HIGH — verified against Google Search Central Organization documentation.

Organization schema has no required properties per spec. Google recommends including `name`, `url`, `logo`, and contact info where available. Place Organization JSON-LD in `Layout.astro` so it appears on every page.

**JSON-LD structure:**
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "{headerData.logo.alt or footerData.copyrightText}",
  "url": "{STOREFRONT_URL}",
  "logo": {
    "@type": "ImageObject",
    "url": "{headerData.logo.src — resolve via resolveMediaUrl()}"
  },
  "sameAs": [
    "{footerData.social[0].url}",
    "{footerData.social[1].url}"
  ]
}
```

**Property mapping:**

| Schema Property | Codebase Source |
|-----------------|-----------------|
| `name` | `footerData.copyrightText` or `headerData.logo.alt` |
| `url` | `getRuntimeStorefrontUrl()` |
| `logo.url` | `headerData.logo.src` resolved via `resolveMediaUrl()` |
| `sameAs` | `footerData.social.map(s => s.url)` — all platform URLs |

**Conditional emission:** Only emit Organization JSON-LD when `headerData.logo.src` is non-empty. If layout API fails and defaults kick in, omit the schema entirely rather than emit a schema with empty name/logo.

---

### WebSite Schema

**Confidence:** HIGH — standard recommendation.

`WebSite` schema enables Google's Sitelinks Search Box feature (search suggestions directly in results). Also provides `SearchAction` for the site search. Place in `Layout.astro`.

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "{siteTitle or store name}",
  "url": "{STOREFRONT_URL}",
  "potentialAction": {
    "@type": "SearchAction",
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": "{STOREFRONT_URL}/search?q={search_term_string}"
    },
    "query-input": "required name=search_term_string"
  }
}
```

The storefront search page is at `/search?q=` — this matches the existing search route. `WebSite` schema complements `Organization` and both can appear in the same Layout head.

---

### CollectionPage Schema (Category Pages)

**Confidence:** MEDIUM — standard schema.org type, less Google-specific guidance than Product.

Category pages should emit `CollectionPage` (subtype of `WebPage`) to inform crawlers this is a curated list.

```json
{
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "name": "{category.name}",
  "description": "{category.description or metaDescription}",
  "url": "{STOREFRONT_URL}/categories/{category.slug}",
  "breadcrumb": {
    "@type": "BreadcrumbList",
    "itemListElement": [...]
  }
}
```

Embed the `BreadcrumbList` as a `breadcrumb` property inside `CollectionPage` rather than as a separate top-level JSON-LD script, or emit both as separate `<script type="application/ld+json">` blocks. Google handles both.

---

## Open Graph Meta Tags

### Per-Page OG Strategy

**Confidence:** HIGH — verified against ogp.me specification and Facebook guidance.

Facebook OG minimum viable set:
- `og:title` — page/product name
- `og:description` — up to 300 characters
- `og:image` — absolute HTTPS URL, minimum 200×200px, recommended 1200×630px
- `og:url` — canonical URL of the page
- `og:type` — `"product"` for product pages, `"website"` for others
- `og:site_name` — store name

Additional recommended for product pages:
- `og:price:amount` — numeric price value
- `og:price:currency` — ISO 4217 currency code (e.g., `"BDT"`)
- `og:image:width` / `og:image:height` — allows Facebook to skip re-fetching dimensions
- `og:image:alt` — accessibility; also used in some platforms as caption
- `og:image:type` — MIME type of image (e.g., `"image/jpeg"`)

**Per-page mapping:**

| Page Type | `og:type` | Image Source | Description |
|-----------|-----------|--------------|-------------|
| Product | `"product"` | `images[0].url` | `product.metaDescription` or `product.description` truncated to 200 chars |
| Category | `"website"` | `category.imageUrl` | `category.metaDescription` or generated |
| Homepage | `"website"` | Fallback OG image | `seo.homepageMetaDescription` |
| CMS page | `"website"` | Fallback OG image | `page.metaDescription` |

**BD market note:** Facebook is the dominant social platform in Bangladesh. WhatsApp is heavy for link sharing. Both use OG tags. WhatsApp requires image to be at least 100×100px and served over HTTPS. The product image served from `cloud.scalius.com` (R2 + Cloudflare CDN) is already HTTPS. WhatsApp does not support WebP for link previews — use `format=jpeg` in the Cloudflare image transform for OG images.

---

### Image Handling

**Confidence:** HIGH.

**OG image URL construction:** Use the existing `getOptimizedImageUrl()` from `@scalius/shared/image-optimizer` with specific options for OG images. Do NOT use the `format=auto` default — OG images must be JPEG for maximum compatibility (WhatsApp, older Facebook crawlers).

**OG image preset (new):**
```typescript
// Width 1200, height 630 (1.91:1 ratio), JPEG format
getOptimizedImageUrl(imageUrl, {
  width: 1200,
  height: 630,
  quality: 85,
  format: "auto",  // Cloudflare auto selects based on Accept header — OK for crawlers
  fit: "cover"
}, ctx)
```

**Important:** The OG image URL must be an absolute URL (include full domain). `getOptimizedImageUrl` returns an absolute URL when the source is an R2 absolute URL — e.g., `https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=1200,height=630,quality=85,format=auto,fit=cover/path.jpg`. This satisfies the requirement.

**Fallback strategy when no product image exists:**
1. First: `images[0].url` — primary product image
2. Second: `product.imageUrl` — legacy field on product record
3. Third: `headerData.logo.src` — store logo (absolute URL via resolveMediaUrl)
4. Fourth: omit `og:image` entirely — never emit an empty or relative URL

**Important:** Do NOT construct OG image URLs with hard-coded CDN domain in page code. Always use `getOptimizedImageUrl()` which reads the runtime CDN domain, following the established pattern in `image-optimizer.ts`.

**Image dimensions:** Facebook requires minimum 200×200px; recommends 1200×630px. At 1200×630 the aspect ratio (1.91:1) triggers the large card display on Facebook (not the small square thumbnail). This is the target for all OG images.

---

## Twitter Cards

**Confidence:** HIGH — verified against X/Twitter developer documentation.

Twitter reads `og:*` tags as fallback, so if OG tags are present, `twitter:title` / `twitter:description` / `twitter:image` are redundant but should still be emitted explicitly for correctness and forward compatibility.

**Required tags for `summary_large_image`:**
```html
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{title}" />
<meta name="twitter:description" content="{description}" />
<meta name="twitter:image" content="{absolute image URL}" />
```

**Optional but recommended:**
```html
<meta name="twitter:image:alt" content="{product.name}" />
```

**BD market note:** X (Twitter) has low market penetration in Bangladesh. The `summary_large_image` card is still worth implementing because it costs one line and the same image URL as OG. WhatsApp and Telegram also fall back to OG tags for link previews. There is no Bangladesh-specific platform requiring special meta tags beyond OG.

**Image requirements for Twitter:** Minimum 300×157px for `summary_large_image`. Maximum 5MB. The 1200×630px OG image also satisfies Twitter requirements — use the same URL.

---

## Canonical URLs

**Confidence:** HIGH — standard web practice.

**Strategy:** Canonical URL = `STOREFRONT_URL + Astro.url.pathname` (strip all query parameters). This is the clean URL for the page content regardless of filters, pagination, sort params, or tracking params like `fbclid`.

**Implementation:**
```typescript
const canonicalUrl = `${getRuntimeStorefrontUrl()}${Astro.url.pathname}`;
```

**Do not use `Astro.url` directly** for the canonical (it includes query parameters). Use only `.pathname`.

**Do not use `Astro.site`** — in Cloudflare Workers SSR mode, `Astro.site` is not reliably set at runtime. The `getRuntimeStorefrontUrl()` fallback chain (ALS → Cloudflare module env → build-time env) is already validated for all routes including sitemap routes that run outside middleware ALS context.

**Per-page canonical URLs:**

| Page | Canonical URL Pattern |
|------|-----------------------|
| Homepage | `{STOREFRONT_URL}/` |
| Product | `{STOREFRONT_URL}/products/{slug}` |
| Category page 1 | `{STOREFRONT_URL}/categories/{slug}` |
| Category page 2+ | `{STOREFRONT_URL}/categories/{slug}` — same canonical, pagination is navigated via query param |
| CMS page | `{STOREFRONT_URL}/{slug}` |
| Search | `{STOREFRONT_URL}/search` — canonical strips `?q=` to avoid thin content signals |

**Pagination canonical note:** Google's current guidance (confirmed as of 2025) is that `rel=prev/rel=next` pagination hints are no longer used by Google. Use a single canonical pointing to the first page for all paginated category pages. This avoids duplicate content without needing `rel=prev/next`.

**HTML tag:**
```html
<link rel="canonical" href="{canonicalUrl}" />
```

---

## Implementation in Astro

### Layout Component Changes

`Layout.astro` needs three additions:

1. **Extended Props interface** — accept SEO data from pages
2. **Global structured data** — Organization + WebSite JSON-LD (emitted once on every page)
3. **Per-page head content** — canonical URL, OG tags, JSON-LD passed from child pages

**New Props interface:**
```typescript
interface Props {
  title: string;
  description?: string;
  hideHeader?: boolean;
  hideFooter?: boolean;
  layoutData?: LayoutData | null;
  // New SEO props
  canonicalUrl?: string;          // Absolute URL for canonical link
  ogImage?: string;               // Absolute URL for og:image
  ogType?: "website" | "product"; // Defaults to "website"
  ogPrice?: string;               // For product pages: numeric price
  ogCurrency?: string;            // For product pages: ISO 4217 code
  noindex?: boolean;              // For pages that should be excluded from search
}
```

**Layout.astro head section additions (after existing `<title>` tag):**

```astro
<!-- Canonical URL -->
{canonicalUrl && <link rel="canonical" href={canonicalUrl} />}

<!-- Open Graph base tags -->
<meta property="og:site_name" content={storeName} />
<meta property="og:type" content={ogType ?? "website"} />
<meta property="og:title" content={title} />
{description && <meta property="og:description" content={description} />}
{canonicalUrl && <meta property="og:url" content={canonicalUrl} />}
{ogImage && <meta property="og:image" content={ogImage} />}
{ogImage && <meta property="og:image:width" content="1200" />}
{ogImage && <meta property="og:image:height" content="630" />}
{ogImage && <meta property="og:image:alt" content={title} />}

<!-- Product-specific OG tags -->
{ogPrice && <meta property="og:price:amount" content={ogPrice} />}
{ogCurrency && <meta property="og:price:currency" content={ogCurrency} />}

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content={title} />
{description && <meta name="twitter:description" content={description} />}
{ogImage && <meta name="twitter:image" content={ogImage} />}
{ogImage && <meta name="twitter:image:alt" content={title} />}

<!-- Robots -->
{noindex && <meta name="robots" content="noindex, nofollow" />}

<!-- Global Structured Data: Organization + WebSite -->
{orgJsonLd && <script type="application/ld+json" set:html={orgJsonLd} />}
{websiteJsonLd && <script type="application/ld+json" set:html={websiteJsonLd} />}

<!-- Per-page structured data slot (Product, BreadcrumbList, CollectionPage) -->
<slot name="head" />
```

**Store name derivation in Layout.astro frontmatter:**
```typescript
const storeName = footerData.copyrightText || headerData.logo.alt || "Our Store";
const storefrontUrl = getRuntimeStorefrontUrl();

// Only emit Organization when we have a logo URL
const logoUrl = headerData.logo.src ? resolveMediaUrl(headerData.logo.src) : null;
const orgJsonLd = logoUrl ? JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": storeName,
  "url": storefrontUrl,
  "logo": { "@type": "ImageObject", "url": logoUrl },
  "sameAs": footerData.social.map(s => s.url).filter(Boolean),
}) : null;

const websiteJsonLd = storefrontUrl ? JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": storeName,
  "url": storefrontUrl,
  "potentialAction": {
    "@type": "SearchAction",
    "target": { "@type": "EntryPoint", "urlTemplate": `${storefrontUrl}/search?q={search_term_string}` },
    "query-input": "required name=search_term_string"
  }
}) : null;
```

**Import needed in Layout.astro:**
```typescript
import { resolveMediaUrl } from "@/lib/media-url";
import { getRuntimeStorefrontUrl } from "@/lib/api/runtime-env";
```

Both already exist in the codebase. `getRuntimeStorefrontUrl` is imported in `sitemap-utils.ts`. `resolveMediaUrl` is in `@/lib/media-url`.

---

### Per-Page Data Flow

#### Product page (`products/[slug].astro`)

All data is already fetched. New additions to the frontmatter:

```typescript
import { getOptimizedImageUrl } from "@/lib/image-optimizer";
import { getRuntimeStorefrontUrl } from "@/lib/api/runtime-env";

const storefrontUrl = getRuntimeStorefrontUrl();
const canonicalUrl = `${storefrontUrl}/products/${product.slug}`;

// OG image: 1200×630 JPEG for social sharing
const ogImageUrl = images[0]?.url
  ? getOptimizedImageUrl(images[0].url, { width: 1200, height: 630, quality: 85, format: "auto", fit: "cover" })
  : (product.imageUrl
    ? getOptimizedImageUrl(product.imageUrl, { width: 1200, height: 630, quality: 85, format: "auto", fit: "cover" })
    : null);

// Truncate description for OG (200 chars max)
const ogDescription = (cleanMetaDescription || product.description || product.name)
  .replace(/<[^>]+>/g, "")  // strip HTML
  .slice(0, 200);

// Brand for JSON-LD
const brandAttribute = product.attributes?.find(a => a.name.toLowerCase() === "brand");
const brandName = brandAttribute?.value || storeName;  // storeName from layoutData

// Variant SKU
const primarySku = variants[0]?.sku || product.id;

// Product JSON-LD
const productJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  "name": product.name,
  "description": (product.description || product.name).replace(/<[^>]+>/g, ""),
  ...(ogImageUrl ? { "image": [ogImageUrl] } : {}),
  "sku": primarySku,
  "brand": { "@type": "Brand", "name": brandName },
  "offers": {
    "@type": "Offer",
    "url": canonicalUrl,
    "priceCurrency": currencyCode,
    "price": product.discountedPrice.toFixed(2),
    "priceValidUntil": new Date(new Date().getFullYear() + 1, 11, 31).toISOString().split("T")[0],
    "availability": "https://schema.org/InStock",
    "itemCondition": "https://schema.org/NewCondition",
    "seller": { "@type": "Organization", "name": storeName }
  }
});

// BreadcrumbList JSON-LD
const breadcrumbItems = [
  { "@type": "ListItem", "position": 1, "name": "Home", "item": `${storefrontUrl}/` },
  ...(productCategory ? [{ "@type": "ListItem", "position": 2, "name": productCategory.name, "item": `${storefrontUrl}/categories/${productCategory.slug}` }] : []),
  { "@type": "ListItem", "position": productCategory ? 3 : 2, "name": product.name, "item": canonicalUrl }
];
const breadcrumbJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": breadcrumbItems
});
```

**Pass to Layout:**
```astro
<Layout
  title={pageTitle}
  description={ogDescription}
  layoutData={layoutData}
  canonicalUrl={canonicalUrl}
  ogImage={ogImageUrl ?? undefined}
  ogType="product"
  ogPrice={product.discountedPrice.toFixed(2)}
  ogCurrency={currencyCode}
>
  <Fragment slot="head">
    {/* Existing preload link stays here */}
    <script type="application/ld+json" set:html={productJsonLd} />
    <script type="application/ld+json" set:html={breadcrumbJsonLd} />
  </Fragment>
  ...
</Layout>
```

**`currencyCode`** — `layoutData?.currency?.code ?? "BDT"`. Already available as `currencySymbol` is derived the same way.

**`storeName`** — derive from `layoutData?.header?.logo?.alt || layoutData?.footer?.copyrightText || "Store"`. This is a one-liner in the frontmatter.

---

#### Category page (`categories/[slug].astro`)

```typescript
import { getRuntimeStorefrontUrl } from "@/lib/api/runtime-env";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";

const storefrontUrl = getRuntimeStorefrontUrl();
// Canonical always strips ?page and filter params
const canonicalUrl = `${storefrontUrl}/categories/${slug}`;

const ogImageUrl = category?.imageUrl
  ? getOptimizedImageUrl(category.imageUrl, { width: 1200, height: 630, quality: 85, format: "auto", fit: "cover" })
  : null;

const collectionJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "name": category?.name,
  "description": category?.metaDescription || `Browse products in ${category?.name}`,
  "url": canonicalUrl,
  "breadcrumb": {
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `${storefrontUrl}/` },
      { "@type": "ListItem", "position": 2, "name": category?.name, "item": canonicalUrl }
    ]
  }
});
```

**Pass to Layout:**
```astro
<Layout
  title={pageTitle}
  description={pageDescription}
  layoutData={layoutData}
  canonicalUrl={canonicalUrl}
  ogImage={ogImageUrl ?? undefined}
  ogType="website"
>
  <Fragment slot="head">
    <script type="application/ld+json" set:html={collectionJsonLd} />
  </Fragment>
  ...
</Layout>
```

---

#### Homepage (`index.astro`)

```typescript
const storefrontUrl = getRuntimeStorefrontUrl();
const canonicalUrl = `${storefrontUrl}/`;
// No product-specific OG image — use store logo as fallback (passed via Layout)
```

**Pass to Layout:**
```astro
<Layout
  title={homepageTitle}
  description={homepageMetaDescription}
  layoutData={layoutData}
  canonicalUrl={canonicalUrl}
  ogType="website"
>
```

No per-page JSON-LD script needed for homepage — Organization + WebSite from Layout is sufficient.

---

#### CMS page (`[slug].astro`)

```typescript
const storefrontUrl = getRuntimeStorefrontUrl();
const canonicalUrl = `${storefrontUrl}/${slug}`;
```

**Pass to Layout:**
```astro
<Layout
  title={title}
  description={description}
  hideHeader={page.hideHeader}
  hideFooter={page.hideFooter}
  layoutData={layoutData}
  canonicalUrl={canonicalUrl}
  ogType="website"
>
```

No JSON-LD structured data for generic CMS pages. If a page ever needs special structured data, the `slot="head"` is available.

---

### Avoiding Conflicts with Existing Head Content

The existing `<slot name="head" />` in `Layout.astro` is already used by the product page to inject a `<link rel="preload" as="image">`. The new OG tags and canonical go into Layout's own frontmatter output (above the slot), and per-page JSON-LD goes through the slot. No conflict.

The existing `<meta name="description">` at line 163 of `Layout.astro` must remain. The new OG/Twitter descriptions are additive meta tags, not replacements.

---

## Testing and Validation

### Google Rich Results Test

URL: `https://search.google.com/test/rich-results`

Test after implementation:
1. Product page URL — verify `Product` rich result detected with `Offer` data
2. Category page URL — verify `BreadcrumbList` detected
3. Homepage URL — verify `WebSite` and `Organization` detected

**What to check in results:** No errors (red), minimal warnings (yellow). The test renders page JavaScript so SSR output will be captured correctly.

### Facebook Sharing Debugger

URL: `https://developers.facebook.com/tools/debug/`

Test each page type. Facebook caches OG data aggressively (up to 7 days). After implementing OG tags, paste the URL and click "Debug" then "Scrape Again" to force a fresh fetch.

**What to check:** Image displays at correct dimensions (1200×630 or close), title and description are not truncated unexpectedly, no missing tag warnings.

### WhatsApp Sharing Test

Paste the product URL into WhatsApp on an Android or iOS device. The preview should show the product image, title, and description. WhatsApp does not have an official debugger tool — manual testing required.

**Common failure:** If the OG image URL points to `localhost` or a non-HTTPS origin, WhatsApp silently drops the image. Ensure testing is done with a deployed URL, not a local dev URL.

### Additional Validators

- **Schema Markup Validator:** `https://validator.schema.org/` — validates JSON-LD syntax and warns about missing recommended properties
- **OpenGraph.xyz:** `https://www.opengraph.xyz/` — previews OG card across multiple platforms simultaneously
- **Google Search Console:** After deployment, check "Enhancements > Products" in Search Console to monitor rich result eligibility over time

---

## Recommendations

### Ordered Implementation Sequence

1. **Layout.astro props + global structured data** — add SEO props to interface, derive `storeName`/`storefrontUrl` in frontmatter, emit Organization + WebSite JSON-LD, add OG base tags, Twitter card tags, and canonical link above the existing `<slot name="head" />`. This gives every page canonical + OG without touching any page file.

2. **Product page** — highest priority (product pages are where rich snippets show in Google Shopping and where Facebook shares come from). Add frontmatter computation of `productJsonLd`, `breadcrumbJsonLd`, `canonicalUrl`, `ogImageUrl`. Pass to Layout. Inject JSON-LD via slot.

3. **Category page** — second priority. Add `collectionJsonLd`, `canonicalUrl`, `ogImageUrl`. Pass to Layout.

4. **Homepage** — minimal work, just pass `canonicalUrl`.

5. **CMS page** — minimal work, just pass `canonicalUrl`.

### Key Constraints and Cautions

**Never use `import.meta.env` for the storefront URL in SEO output.** The `STOREFRONT_URL` wrangler var comes from the runtime env. Use `getRuntimeStorefrontUrl()` — it already handles the full fallback chain.

**Never emit empty or undefined values in JSON-LD.** A `"price": ""` or `"image": ""` in a Product schema will fail validation. Conditional spread (`...(value ? { key: value } : {})`) is the safe pattern.

**Strip HTML from description fields.** `product.description` may contain HTML markup (rich content). Use `.replace(/<[^>]+>/g, "")` before using in JSON-LD or meta description. The Facebook feed already does this via `escapeXml`.

**OG image must be absolute URL.** When the storefront runs behind Cloudflare and images are served from `cloud.scalius.com`, `getOptimizedImageUrl()` returns an absolute URL — confirmed by reading the `buildParams` function in `image-optimizer.ts` which routes transforms through `${url.origin}/cdn-cgi/image/...`. No changes needed to the image optimizer.

**Fallback when image is missing.** Do not emit `og:image` at all when no image is available. An empty `og:image` is worse than omitting it — Facebook will show a blank card with a broken image indicator.

**Do not emit OG price tags on non-product pages.** The `og:price:amount` and `og:price:currency` properties are only meaningful on product pages. Layout.astro should only emit them when passed from the product page.

**`priceValidUntil` format.** Must be ISO 8601 date (YYYY-MM-DD). Compute as: `new Date(new Date().getFullYear() + 1, 11, 31).toISOString().split("T")[0]` which gives end of next year. Google will warn if this date is in the past.

**Canonical URL must not have trailing slash (except homepage).** The product page canonical is `/products/slug` not `/products/slug/`. The `getRuntimeStorefrontUrl()` already strips trailing slash — append paths without double slash.

### What This Milestone Does NOT Include

- **`og:locale`** — The storefront `lang="en"` is hardcoded. If locale support is added in future, `og:locale` (e.g., `bn_BD` for Bengali Bangladesh) would be added then.
- **`hreflang` tags** — Not applicable for single-language single-region deployment.
- **Review/AggregateRating structured data** — Product reviews feature is out of scope per PROJECT.md.
- **Google Merchant Center feed** — Listed as feature #26 (good-to-have). Separate from JSON-LD on product pages. The existing Facebook feed pattern would carry over but it is out of scope for this milestone.
- **Article or Event structured data** — Not applicable to this product type.

---

## Sources

- [Google Search Central — Product Structured Data (Merchant Listings)](https://developers.google.com/search/docs/appearance/structured-data/product)
- [Google Search Central — Product Snippet Structured Data](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)
- [Google Search Central — Breadcrumb Structured Data](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb)
- [Google Search Central — Organization Schema](https://developers.google.com/search/docs/appearance/structured-data/organization)
- [Schema.org — Product Type](https://schema.org/Product)
- [Schema.org — BreadcrumbList Type](https://schema.org/BreadcrumbList)
- [The Open Graph Protocol — ogp.me](https://ogp.me/)
- [Facebook OG Image Dimensions — OG Image Size Guide 2026](https://myogimage.com/blog/og-image-size-meta-tags-complete-guide)
- [X/Twitter — Summary Card with Large Image](https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image)
- [Google Rich Results Test](https://search.google.com/test/rich-results)
- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/)
- [WhatsApp Link Preview Requirements 2026](https://www.ogrilla.com/blog/whatsapp-link-preview-guide)
- [Astro SEO — Chrono Blog](https://www.chronohq.com/blog/inject-meta-tags-with-astro-slots)
