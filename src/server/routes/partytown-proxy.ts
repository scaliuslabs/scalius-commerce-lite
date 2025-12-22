import { Hono } from "hono";

function getAllowedDomains(): string[] {
  const cspAllowed = process.env.CSP_ALLOWED || "";
  if (!cspAllowed.trim()) {
    console.warn("[Partytown Proxy] No CSP_ALLOWED domains configured");
    return [];
  }

  const domains = cspAllowed
    .split(",")
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0)
    .map((domain) => domain.replace(/^https?:\/\//, ""))
    .flatMap((domain) => {
      if (domain.startsWith("*.")) {
        return [domain.slice(2), domain];
      }
      return [domain, `*.${domain}`];
    })
    .map((domain) => domain.replace(/^\*\./, ""))
    .filter((domain, index, arr) => arr.indexOf(domain) === index);

  console.log("[Partytown Proxy] Allowed domains:", domains);
  return domains;
}

const app = new Hono();

// Handle CORS preflight requests
app.options("/", async (_c) => {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, User-Agent",
      "Access-Control-Max-Age": "86400", // Cache preflight for 24 hours
    },
  });
});

app.get("/", async (c) => {
  const urlParam = c.req.query("url");

  if (!urlParam) {
    return c.json({ error: "Missing url parameter" }, 400, {
      "Access-Control-Allow-Origin": "*",
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(urlParam);
  } catch (e) {
    return c.json({ error: "Invalid url parameter" }, 400, {
      "Access-Control-Allow-Origin": "*",
    });
  }

  const allowedDomains = getAllowedDomains();
  const isAllowed = allowedDomains.some((domain) => {
    if (domain.includes("*")) {
      const domainPattern = domain.replace(/\*/g, ".*");
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
      "Access-Control-Allow-Origin": "*",
    });
  }

  try {
    // Fetch the original resource from Facebook
    const response = await fetch(targetUrl.toString(), {
      headers: {
        // Forward necessary headers if required, or keep it simple
        Accept: c.req.header("Accept") || "*/*",
        "User-Agent":
          c.req.header("User-Agent") ||
          "Mozilla/5.0 (compatible; Partytown-Proxy/1.0)",
        // Add other headers like User-Agent if needed
      },
      redirect: "follow", // Handle redirects if Facebook uses them
    });

    if (!response.ok) {
      console.error(
        `Proxy failed: Upstream fetch error ${response.status} for ${targetUrl}`,
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Get content type from original response
    const contentType =
      response.headers.get("Content-Type") || "application/javascript";
    // Get caching headers from original response or set sensible defaults
    const cacheControl =
      response.headers.get("Cache-Control") || "public, max-age=3600"; // Cache for 1 hour by default

    // Create a new response
    const proxyResponse = new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*", // Allow Partytown worker origin
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, User-Agent",
        "Cache-Control": cacheControl,
        // Copy other relevant headers from FB response if necessary
      },
    });

    return proxyResponse;
  } catch (error) {
    console.error(`Proxy error fetching ${targetUrl}:`, error);
    return c.json({ error: "Proxy failed" }, 500, {
      "Access-Control-Allow-Origin": "*",
    });
  }
});

export { app as partytownProxyRoutes };
