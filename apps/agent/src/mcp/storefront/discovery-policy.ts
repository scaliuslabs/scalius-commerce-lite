import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

type JsonRecord = Record<string, unknown>;

const PUBLIC_SEO_PATH = "/api/v1/seo";
const MAX_TEXT_LENGTH = 180;

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const storefrontDiscoveryPolicyInputSchema = z.object({}).strict();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFallback(body: JsonRecord): string {
  return JSON.stringify(body, null, 2);
}

function toolResult(body: JsonRecord, isError = false): CallToolResult {
  return {
    structuredContent: body,
    content: [{ type: "text", text: textFallback(body) }],
    ...(isError ? { isError: true } : {}),
  };
}

function discoveryPolicyToolError(code = "temporarily_unavailable"): CallToolResult {
  return toolResult({
    storefrontDiscoveryPolicy: {
      source: { path: PUBLIC_SEO_PATH },
      discovery: {
        sitemap: { enabled: false, sections: {}, urls: [] },
        feeds: { productCatalogEnabled: false, includeUnavailableProducts: false, urls: [] },
        robots: { advertiseSitemap: false },
        structuredData: {},
      },
      returnPolicy: { enabled: false },
      limits: {
        readOnly: true,
        canMutate: false,
        includesCustomerData: false,
        includesPaymentData: false,
        includesCheckoutData: false,
      },
    },
    error: {
      code,
      message: "Storefront discovery policy is temporarily unavailable.",
    },
  }, true);
}

async function parseJsonResponse(response: Response): Promise<JsonRecord | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : { value: body };
  } catch {
    return null;
  }
}

async function readSeoPolicy(env: Env, signal?: AbortSignal): Promise<JsonRecord | null> {
  if (!env.API || typeof env.API.fetch !== "function") {
    return null;
  }

  const response = await env.API.fetch(new URL(`http://api.internal${PUBLIC_SEO_PATH}`), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await parseJsonResponse(response);
  return response.ok && body?.success === true && isRecord(body.data) ? body.data : null;
}

function compactString(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function resolveStorefrontBaseUrl(env: Pick<Env, "STOREFRONT_URL">): string | null {
  const configured = env.STOREFRONT_URL?.trim();
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function buildAbsoluteStorefrontUrl(env: Env, path: string): string | null {
  const baseUrl = resolveStorefrontBaseUrl(env);
  if (!baseUrl || !path.startsWith("/")) return null;
  try {
    return new URL(path, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

function sameStoreOrHttpUrl(env: Env, value: unknown): string | null {
  const candidate = compactString(value, 300);
  if (!candidate) return null;

  if (candidate.startsWith("/")) {
    return buildAbsoluteStorefrontUrl(env, candidate);
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function maybePushUrl(list: JsonRecord[], type: string, url: string | null): void {
  if (url) list.push({ type, url });
}

function compactDiscovery(data: JsonRecord, env: Env): JsonRecord {
  const discovery = isRecord(data.discovery) ? data.discovery : {};
  const sitemap = isRecord(discovery.sitemap) ? discovery.sitemap : {};
  const feeds = isRecord(discovery.feeds) ? discovery.feeds : {};
  const robots = isRecord(discovery.robots) ? discovery.robots : {};
  const structuredData = isRecord(discovery.structuredData) ? discovery.structuredData : {};

  const sitemapUrls: JsonRecord[] = [];
  if (sitemap.enabled === true) {
    maybePushUrl(sitemapUrls, "index", buildAbsoluteStorefrontUrl(env, "/sitemap.xml"));
    if (sitemap.staticPages === true) {
      maybePushUrl(sitemapUrls, "static", buildAbsoluteStorefrontUrl(env, "/sitemap-static.xml"));
    }
    if (sitemap.products === true) {
      maybePushUrl(sitemapUrls, "products", buildAbsoluteStorefrontUrl(env, "/sitemap-products.xml"));
    }
    if (sitemap.categories === true) {
      maybePushUrl(sitemapUrls, "categories", buildAbsoluteStorefrontUrl(env, "/sitemap-categories.xml"));
    }
    if (sitemap.collections === true) {
      maybePushUrl(sitemapUrls, "collections", buildAbsoluteStorefrontUrl(env, "/sitemap-collections.xml"));
    }
    if (sitemap.pages === true) {
      maybePushUrl(sitemapUrls, "pages", buildAbsoluteStorefrontUrl(env, "/sitemap-pages.xml"));
    }
  }

  const feedUrls: JsonRecord[] = [];
  if (feeds.productCatalogEnabled === true) {
    maybePushUrl(feedUrls, "google", buildAbsoluteStorefrontUrl(env, "/api/product-feed.xml"));
    maybePushUrl(feedUrls, "facebook", buildAbsoluteStorefrontUrl(env, "/api/facebook-feed.xml"));
  }

  return {
    sitemap: {
      enabled: sitemap.enabled === true,
      sections: {
        staticPages: sitemap.staticPages === true,
        products: sitemap.products === true,
        categories: sitemap.categories === true,
        collections: sitemap.collections === true,
        pages: sitemap.pages === true,
      },
      urls: sitemapUrls,
    },
    feeds: {
      productCatalogEnabled: feeds.productCatalogEnabled === true,
      includeUnavailableProducts: feeds.includeUnavailableProducts === true,
      variantStrategy: compactString(feeds.variantStrategy, 20),
      title: compactString(feeds.title),
      description: compactString(feeds.description),
      urls: feedUrls,
    },
    robots: {
      advertiseSitemap: robots.advertiseSitemap === true,
      robotsUrl: buildAbsoluteStorefrontUrl(env, "/robots.txt"),
    },
    structuredData: {
      organization: structuredData.organization === true,
      websiteSearch: structuredData.websiteSearch === true,
      products: structuredData.products === true,
      productGroups: structuredData.productGroups === true,
      offerShippingDetails: structuredData.offerShippingDetails === true,
      breadcrumbs: structuredData.breadcrumbs === true,
      collections: structuredData.collections === true,
    },
  };
}

function compactReturnPolicy(data: JsonRecord, env: Env): JsonRecord {
  const returnPolicy = isRecord(data.returnPolicy) ? data.returnPolicy : {};
  if (returnPolicy.enabled !== true) {
    return { enabled: false };
  }

  return {
    enabled: true,
    country: compactString(returnPolicy.country, 8),
    category: compactString(returnPolicy.category),
    returnWindowDays: typeof returnPolicy.returnWindowDays === "number"
      ? returnPolicy.returnWindowDays
      : null,
    returnFees: compactString(returnPolicy.returnFees),
    returnMethod: compactString(returnPolicy.returnMethod),
    policyUrl: sameStoreOrHttpUrl(env, returnPolicy.policyUrl),
  };
}

async function callStorefrontDiscoveryPolicy(
  env: Env,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    const seo = await readSeoPolicy(env, signal);
    if (!seo) return discoveryPolicyToolError("public_seo_unavailable");

    return toolResult({
      storefrontDiscoveryPolicy: {
        source: { path: PUBLIC_SEO_PATH },
        discovery: compactDiscovery(seo, env),
        returnPolicy: compactReturnPolicy(seo, env),
        limits: {
          readOnly: true,
          canMutate: false,
          includesCustomerData: false,
          includesPaymentData: false,
          includesCheckoutData: false,
        },
      },
    });
  } catch {
    return discoveryPolicyToolError();
  }
}

export function registerStorefrontDiscoveryPolicyTool(server: McpServer, env: Env): void {
  server.registerTool(
    "storefront_discovery_policy",
    {
      title: "Storefront Discovery Policy",
      description: "Reads public storefront discovery, feed, robots, schema, and return-policy facts.",
      inputSchema: storefrontDiscoveryPolicyInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (_args, extra) => callStorefrontDiscoveryPolicy(env, extra.signal),
  );
}
