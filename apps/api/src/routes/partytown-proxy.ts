import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "@scalius/database/client";
import { securitySettingsDocument } from "@scalius/core/modules/settings/security-settings.service";
import { errorResponses } from "../schemas/responses";

const ALLOWED_PROXY_PROTOCOLS = new Set(["https:"]);

/** KV mirror written by the Security settings save handler. */
export { CSP_ALLOWED_DOMAINS_CACHE_KEY } from "@scalius/core/modules/settings/security-settings.service";

/**
 * The merchant CSP allow-list is dashboard-managed (Settings -> Security).
 * The settings document owns the storage, the KV mirror, and the read order:
 * KV first, then the `settings` row once on a miss, mirrored back so later
 * requests stay on the KV path. Failing to read anything yields the empty
 * default, which blocks every proxy target.
 */
async function readMerchantCspAllowedDomains(env: Env): Promise<string> {
  const ctx = { kv: env.CACHE };
  // A KV hit answers without opening the relational provider at all.
  const cached = await securitySettingsDocument.readCached(ctx);
  if (cached) return cached.cspAllowedDomains;

  try {
    // On a miss the document reads the row once and mirrors it back to KV.
    const value = await securitySettingsDocument.read(getDb(env), ctx, {
      skipCache: true,
    });
    return value.cspAllowedDomains;
  } catch (error: unknown) {
    console.error("[Partytown Proxy] Failed to read the CSP allow-list", error);
    return "";
  }
}

async function getAllowedDomainsAsync(c: { env: Env; req: { url: string } }): Promise<string[]> {
  const cspAllowed = await readMerchantCspAllowedDomains(c.env);

  if (!cspAllowed.trim()) {
    console.warn("[Partytown Proxy] No merchant CSP allow-list configured");
    return [];
  }

  const domains = cspAllowed
    .split(",")
    .map((domain: string) => domain.trim())
    .filter((domain: string) => domain.length > 0)
    .map((domain: string) => domain.replace(/^https?:\/\//, ""))
    .flatMap((domain: string) => {
      if (domain.startsWith("*.")) {
        return [domain.slice(2), domain];
      }
      return [domain, `*.${domain}`];
    })
    .map((domain: string) => domain.replace(/^\*\./, ""))
    .filter((domain: string, index: number, arr: string[]) => arr.indexOf(domain) === index);

  console.log("[Partytown Proxy] Allowed domains:", domains);
  return domains;
}

const app = new OpenAPIHono<{ Bindings: Env }>();

// Handle CORS preflight requests
app.options("/", async (_c) => {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, User-Agent",
      "Access-Control-Max-Age": "86400"
    }
  });
});

// ─── GET / ───────────────────────────────────────────────────────────────────

const proxyRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Partytown Proxy"],
  summary: "Proxy requests to allowed domains for Partytown",
  request: {
    query: z.object({
      url: z.string().openapi({ description: "Target URL to proxy" })
    })
  },
  responses: {
    200: {
      description: "Proxied response",
      content: { "*/*": { schema: z.unknown() } },
    },
    400: errorResponses[400],
    403: errorResponses[403],
  }
});

app.openapi(proxyRoute, async (c) => {
  const urlParam = c.req.valid("query").url;

  if (!urlParam) {
    return c.json({ error: "Missing url parameter" }, 400, {
      "Access-Control-Allow-Origin": "*"
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(urlParam);
  } catch {
    return c.json({ error: "Invalid url parameter" }, 400, {
      "Access-Control-Allow-Origin": "*"
    });
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(targetUrl.protocol)) {
    console.warn(
      `Blocked proxy attempt to disallowed protocol: ${targetUrl.protocol}`,
    );
    return c.json({ error: "Proxying this protocol is not allowed" }, 403, {
      "Access-Control-Allow-Origin": "*"
    });
  }

  const allowedDomains = await getAllowedDomainsAsync(c);
  const escapeRegex = (str: string): string =>
    str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const isAllowed = allowedDomains.some((domain) => {
    if (domain.includes("*")) {
      const domainPattern = escapeRegex(domain).replace(/\\\*/g, ".*");
      return new RegExp(`^${domainPattern}$`).test(targetUrl.hostname);
    }
    return targetUrl.hostname === domain;
  });

  if (!isAllowed) {
    console.warn(
      `Blocked proxy attempt to disallowed domain: ${targetUrl.hostname}`,
    );
    console.warn(`Allowed domains: ${allowedDomains.join(", ")}`);
    return c.json({ error: "Proxying to this domain is not allowed" }, 403, {
      "Access-Control-Allow-Origin": "*"
    });
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        Accept: c.req.header("Accept") || "*/*",
        "User-Agent":
          c.req.header("User-Agent") ||
          "Mozilla/5.0 (compatible; Partytown-Proxy/1.0)"
      },
      redirect: "follow"
    });

    if (!response.ok) {
      console.error(
        `Proxy failed: Upstream fetch error ${response.status} for ${targetUrl}`,
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    const contentType =
      response.headers.get("Content-Type") || "application/javascript";
    const cacheControl =
      response.headers.get("Cache-Control") || "public, max-age=3600";

    const proxyResponse = new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, User-Agent",
        "Cache-Control": cacheControl
      }
    });

    return proxyResponse;
  } catch (error: unknown) {
    console.error(`Proxy error fetching ${targetUrl}:`, error);
    return c.json({ error: "Proxy failed" }, 500, {
      "Access-Control-Allow-Origin": "*"
    });
  }
});

export { app as partytownProxyRoutes };
