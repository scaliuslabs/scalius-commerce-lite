import { normalizeSeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import type { LayoutData } from "@/lib/api/storefront";
import {
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_MCP_PATH,
  UCP_VERSION,
} from "@/lib/ucp/catalog";

/** Top-level categories an agent is told the store sells, at most. */
const LLMS_TXT_CATEGORIES_MAX = 12;

/** What `/llms.txt` says about this store, read from the layout the route already has. */
export interface LlmsTxtStore {
  name: string;
  categories: Array<{ name: string; path: string }>;
  /** The store has more categories than listed (the /categories index lists them all). */
  moreCategories: boolean;
  policies: Array<{ title: string; path: string }>;
  contact: { email: string | null; phone: string | null };
  /** The merchant publishes the product feed (Settings -> SEO). */
  productFeed: boolean;
}

/** One line of merchant text in Markdown: no line breaks, no link brackets. */
function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "").trim();
}

function samePath(path: string): string | null {
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

export function llmsTxtStoreOf(layout: LayoutData | null, baseUrl: string): LlmsTxtStore {
  const nodes = layout?.categoryTree?.nodes ?? [];
  const roots = nodes.filter((node) => node.parentId === null);
  const business = layout?.business;
  return {
    name: inline(business?.companyName ?? "") || new URL(baseUrl).host,
    categories: roots.slice(0, LLMS_TXT_CATEGORIES_MAX).flatMap((node) => {
      const path = samePath(node.canonicalPath ?? "") ?? `/categories/${encodeURIComponent(node.slug)}`;
      const name = inline(node.name);
      return name ? [{ name, path }] : [];
    }),
    moreCategories: roots.length > LLMS_TXT_CATEGORIES_MAX || layout?.categoryTree?.truncated === true,
    policies: (layout?.policies ?? []).flatMap((policy) => {
      const path = samePath(policy.path);
      const title = inline(policy.title);
      return path && title ? [{ title, path }] : [];
    }),
    contact: { email: inline(business?.email ?? "") || null, phone: inline(business?.phone ?? "") || null },
    productFeed: normalizeSeoDiscoverySettings(layout?.seo?.discovery).feeds.productCatalogEnabled,
  };
}

/**
 * The store's guide for language models (llmstxt.org): who the store is, what
 * it sells, where its policies and contact are, and the machine-readable
 * ways in (sitemap, product feed when published, the read-only UCP catalog).
 */
export function buildLlmsTxt(baseUrl: string, store: LlmsTxtStore): string {
  const link = (title: string, path: string, note = "") => `- [${title}](${baseUrl}${path})${note ? `: ${note}` : ""}`;
  const sections = [
    `# ${store.name}\n\n> The online store of ${store.name}: its catalog, prices and availability, readable by shopping and research agents through the links below.`,
  ];
  if (store.categories.length > 0) {
    sections.push([
      "## What the store sells",
      "",
      ...store.categories.map((category) => link(category.name, category.path)),
      ...(store.moreCategories ? [link("All categories", "/categories")] : []),
    ].join("\n"));
  }
  const contact = [
    ...(store.contact.email ? [`- Email: ${store.contact.email}`] : []),
    ...(store.contact.phone ? [`- Phone: ${store.contact.phone}`] : []),
  ];
  if (store.policies.length > 0 || contact.length > 0) {
    sections.push(["## Policies and contact", "", ...store.policies.map((policy) => link(policy.title, policy.path)), ...contact].join("\n"));
  }
  sections.push([
    "## Machine-readable resources",
    "",
    link("Storefront", "/", "Buyer-visible catalog and commerce experience."),
    link("UCP profile", "/.well-known/ucp", "Machine-readable service and capability discovery."),
    link("Sitemap", "/sitemap.xml", "Canonical public page discovery."),
    ...(store.productFeed ? [link("Product feed", "/api/product-feed.xml", "The merchant's catalog feed.")] : []),
  ].join("\n"));
  sections.push(`## UCP catalog quick start

1. GET ${baseUrl}/.well-known/ucp and resolve the advertised REST and MCP endpoints, protocol version, and capabilities from the profile.
2. This storefront currently advertises only ${UCP_CATALOG_SEARCH_CAPABILITY} and ${UCP_CATALOG_LOOKUP_CAPABILITY} for UCP ${UCP_VERSION}.
3. Send catalog requests with Content-Type: application/json and UCP-Agent: profile="https://your-agent.example/.well-known/ucp". The profile URL must identify the calling platform over HTTPS.
4. Search with POST ${baseUrl}/ucp/catalog/search and a body such as {"query":"shoes","context":{"address_country":"US","currency":"USD","language":"en"}}. The context picks the market whose prices, currency, and language you get; prices are integer minor units.
5. Resolve product, variant, SKU, handle, or same-store product URL identifiers with POST ${baseUrl}/ucp/catalog/lookup and a body such as {"ids":["product-or-sku"]}; get one product's full detail with POST ${baseUrl}/ucp/catalog/product and {"id":"product-or-sku"}.
6. MCP clients call the same catalog at POST ${baseUrl}${UCP_MCP_PATH} (tools search_catalog, lookup_catalog, get_product) with arguments such as {"meta":{"ucp-agent":{"profile":"https://your-agent.example/.well-known/ucp"}},"catalog":{"query":"shoes"}}.
7. Follow response pagination, messages, and policies. Treat catalog price and availability as advisory buyer-visible facts.

## Scope

UCP access is read-only. Cart, checkout, order, fulfillment, payment, and recovery capabilities are not advertised; do not infer or call them. Use the buyer-facing storefront for state-changing commerce flows.`);
  return `${sections.join("\n\n")}\n`;
}

export function llmsTxtResponse(baseUrl: string, store: LlmsTxtStore): Response {
  return new Response(buildLlmsTxt(baseUrl, store), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}

export function llmsTxtUnavailableResponse(): Response {
  return new Response("LLM discovery is temporarily unavailable.\n", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
