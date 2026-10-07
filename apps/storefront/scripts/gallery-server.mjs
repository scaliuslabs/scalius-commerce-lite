#!/usr/bin/env node
/**
 * The storefront section gallery server (dev and test only; `pnpm gallery:storefront`).
 *
 * It loads the real storefront pages through Vite in middleware mode (the
 * same way the render tests do), answers every API read from the fixture
 * store in apps/storefront/src/gallery, and serves:
 *
 *   /__gallery/            the index of every entry (HTML)
 *   /__gallery/index.json  the entries as data (the quality audit reads it)
 *   /__gallery/e/<id>      one entry: a real page rendered with its theme
 *   /__gallery/media/<id>  the fixture images (generated SVG)
 *
 * No secrets, no API, no Wrangler: it never runs in a deployed Worker and
 * nothing in the production build imports it (docs/STOREFRONT-QUALITY.md).
 *
 *   pnpm gallery:storefront [--port 4799]
 */
import { createServer as createHttpServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

const STOREFRONT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const GALLERY_PREFIX = "/__gallery";
export const DEFAULT_GALLERY_PORT = 4799;

// The Worker module the Cloudflare adapter provides (the gallery renders in Node).
const VIRTUAL_MODULES = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
};

const CSS_MODULE = /\.(css|scss|sass|less|styl|pcss|postcss)($|\?)|[?&]lang\.css($|&)/;

/**
 * Every stylesheet a page imports from its script graph, as Vite URLs, in
 * import order: what Astro's dev server links for a route. A stylesheet's
 * own @imports are compiled into it, so they are not followed.
 */
function collectStyles(server, entryId) {
  const graph = server.environments?.ssr?.moduleGraph ?? server.moduleGraph;
  const seen = new Set();
  const styles = [];
  const visit = (mod) => {
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    for (const imported of mod.importedModules) {
      const id = imported.id ?? imported.url ?? "";
      if (CSS_MODULE.test(id)) {
        if (!/[?&](inline|raw|url)\b/.test(id) && !styles.includes(imported.url)) styles.push(imported.url);
        continue;
      }
      visit(imported);
    }
  };
  visit(graph.getModuleById(entryId));
  return styles;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

/**
 * Starts the gallery server. Resolves to `{ url, close }`. Refuses to run
 * with NODE_ENV=production: the gallery is never part of a deployment.
 */
export async function startStorefrontGallery({ port = DEFAULT_GALLERY_PORT, host = "127.0.0.1", quiet = false } = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The storefront gallery is dev and test only; it does not run with NODE_ENV=production.");
  }
  // The HTTP server comes first: Vite's client connects its socket to it.
  let handle = (_request, response) => {
    response.writeHead(503);
    response.end();
  };
  const http = createHttpServer((request, response) => handle(request, response));
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  const address = http.address();
  const origin = `http://${host}:${typeof address === "object" && address ? address.port : port}`;

  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  // The storefront's own Astro config (integrations, Tailwind, Vite settings)
  // without the Cloudflare adapter: the gallery renders in Node.
  const { default: storefrontConfig } = await import("../astro.config.mjs");
  const { adapter: _adapter, server: _server, ...astroConfig } = storefrontConfig;
  const configure = getViteConfig(
    {
      root: STOREFRONT_ROOT,
      logLevel: quiet ? "error" : "warn",
      server: { middlewareMode: true, hmr: { server: http }, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "storefront-gallery-virtual-modules",
          resolveId: (id) => (id in VIRTUAL_MODULES ? `\0storefront-gallery:${id}` : undefined),
          load: (id) => (id.startsWith("\0storefront-gallery:") ? VIRTUAL_MODULES[id.slice("\0storefront-gallery:".length)] : undefined),
        },
      ],
    },
    { ...astroConfig, configFile: false, root: STOREFRONT_ROOT, logLevel: "error", devToolbar: { enabled: false } },
  );
  const vite = await createServer({ ...(await configure({ mode: "development", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await vite.ssrLoadModule("astro/container");
  const reactRenderer = (await vite.ssrLoadModule("@astrojs/react/server.js")).default;
  const container = await experimental_AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/react", renderer: reactRenderer });
  container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
  const gallery = await vite.ssrLoadModule("/src/gallery/server.ts");
  const runtimeModule = await vite.ssrLoadModule("/src/lib/api/runtime.ts");

  // Every API read of a render is answered by the entry's fixture API; any
  // other request leaves nothing (the gallery is hermetic).
  const currentEntry = new AsyncLocalStorage();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const entry = currentEntry.getStore();
    if (entry && request.url.startsWith(gallery.GALLERY_API_ORIGIN)) return gallery.answerFixtureApi(entry, request);
    if (entry) return new Response("{}", { status: 404 });
    return realFetch(input, init);
  };

  handle = async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    try {
      if (url.pathname === `${GALLERY_PREFIX}/index.json`) {
        return sendJson(response, 200, { entries: gallery.galleryIndex() });
      }
      if (url.pathname === GALLERY_PREFIX || url.pathname === `${GALLERY_PREFIX}/`) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return response.end(gallery.galleryIndexHtml());
      }
      if (url.pathname.startsWith(`${GALLERY_PREFIX}/media/`)) {
        const media = gallery.galleryMedia(decodeURIComponent(url.pathname.slice(`${GALLERY_PREFIX}/media/`.length)));
        if (!media) return sendJson(response, 404, { error: "unknown media" });
        response.writeHead(200, { "Content-Type": media.contentType, "Cache-Control": "public, max-age=3600" });
        return response.end(media.body);
      }
      if (url.pathname.startsWith(`${GALLERY_PREFIX}/e/`)) {
        const id = decodeURIComponent(url.pathname.slice(`${GALLERY_PREFIX}/e/`.length));
        const plan = gallery.galleryRenderPlan(id, origin);
        if (!plan) return sendJson(response, 404, { error: `unknown entry ${id}` });
        const pageModule = await vite.ssrLoadModule(plan.page);
        const rendered = await currentEntry.run(plan.entry, () =>
          runtimeModule.requestRuntime.run(plan.runtime, () =>
            container.renderToResponse(pageModule.default, {
              request: new Request(plan.url, { headers: plan.headers }),
              params: plan.params,
              locals: {},
            }),
          ),
        );
        let html = await rendered.text();
        const resolved = await vite.moduleGraph.getModuleByUrl(plan.page, true);
        const styles = collectStyles(vite, resolved?.id ?? plan.page);
        const links = styles.map((href) => `<link rel="stylesheet" href="${href}${href.includes("?") ? "&" : "?"}direct">`).join("");
        html = html.includes("</head>") ? html.replace("</head>", `${links}</head>`) : `${links}${html}`;
        response.writeHead(rendered.status === 200 ? 200 : rendered.status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Gallery-Entry": id,
        });
        return response.end(html);
      }
      vite.middlewares(request, response, () => sendJson(response, 404, { error: "not found" }));
    } catch (error) {
      if (!quiet) console.error(`[gallery] ${url.pathname}:`, error);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error?.stack ?? error));
    }
  };
  return {
    url: origin,
    async close() {
      globalThis.fetch = realFetch;
      await new Promise((resolve) => http.close(() => resolve()));
      http.closeAllConnections?.();
      await vite.close();
    },
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_GALLERY_PORT;
  const { url, close } = await startStorefrontGallery({ port });
  console.log(`Storefront gallery: ${url}${GALLERY_PREFIX}/`);
  const stop = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
