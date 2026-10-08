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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STOREFRONT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const GALLERY_PREFIX = "/__gallery";
export const DEFAULT_GALLERY_PORT = 4799;
/** The fixture API path segment that means "the entry of the page that asked". */
const REFERER_ENTRY = "__referer";

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

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

/** What Vite serves: modules, dependencies, files by path and the public folder. */
function isDevAsset(pathname) {
  if (["/@", "/src/", "/node_modules/", "/~partytown/"].some((prefix) => pathname.startsWith(prefix))) return true;
  if (pathname.startsWith(`${REPO_ROOT}/`)) return true;
  const file = join(STOREFRONT_ROOT, "public", decodeURIComponent(pathname));
  return pathname !== "/" && existsSync(file) && statSync(file).isFile();
}

/** Every storefront route as [pattern, module, param names], static routes first (Astro's priority, simplified). */
function storefrontRoutes() {
  const pagesDir = join(STOREFRONT_ROOT, "src/pages");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(astro|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(path.slice(pagesDir.length).replace(/\\/g, "/"));
    }
  };
  walk(pagesDir);
  return files
    .map((file) => {
      const names = [];
      const route = file.replace(/\.(astro|ts)$/, "").replace(/\/index$/, "") || "/";
      const source = route.split("/").map((segment) => {
        const rest = /^\[\.\.\.(\w+)\]$/.exec(segment);
        if (rest) { names.push(rest[1]); return "(.*)"; }
        return segment.replace(/\[(\w+)\]/g, (_, name) => { names.push(name); return "([^/]+)"; }).replace(/\./g, "\\.");
      }).join("/");
      return { pattern: new RegExp(`^${source || "/"}/?$`), module: `/src/pages${file}`, names, dynamic: names.length };
    })
    .sort((left, right) => left.dynamic - right.dynamic);
}

/** The storefront page or endpoint for a path (`/navigation/panels`, `/api/reviews/<id>/mine`), or null. */
function routeModule(routes, pathname) {
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (match) return { module: route.module, params: Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")])) };
  }
  return null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
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
  // Browser code without a page API URL falls back to the dev API origin:
  // here, the fixture API of the page that asked (its Referer).
  astroConfig.vite = {
    ...astroConfig.vite,
    define: { ...astroConfig.vite?.define, __SCALIUS_DEV_API_ORIGIN__: JSON.stringify(`${origin}${GALLERY_PREFIX}/api/${REFERER_ENTRY}`) },
  };
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
  const routes = storefrontRoutes();

  // Every API read of a render is answered by the entry's fixture API; any
  // other request leaves nothing (the gallery is hermetic).
  const currentEntry = new AsyncLocalStorage();
  const apiPrefix = `${origin}${gallery.GALLERY_API_PREFIX}`;
  const apiRoot = `${origin}/api/v1/`;
  /** The entry a fixture API URL names (`/__gallery/api/<id>/...`), or the Referer's entry. */
  const apiEntry = (url, referer) => {
    const named = decodeURIComponent(url.slice(apiPrefix.length).split("/")[0] ?? "");
    const id = named === REFERER_ENTRY ? /\/__gallery\/e\/([^/?#]+)/.exec(String(referer ?? ""))?.[1] : named;
    return id ? gallery.galleryEntry(decodeURIComponent(id)) : null;
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const rendering = currentEntry.getStore();
    if (request.url.startsWith(apiPrefix)) {
      const entry = apiEntry(request.url, null) ?? rendering;
      return entry ? gallery.answerFixtureApi(entry, request) : new Response("{}", { status: 404 });
    }
    // The layout names the origin as the API (Platform settings take an origin
    // only): a render's own read of `<origin>/api/v1/...` is its entry's fixture.
    if (request.url.startsWith(apiRoot) && rendering) {
      return gallery.answerFixtureApi(rendering, new Request(`${apiPrefix}${encodeURIComponent(rendering.id)}${request.url.slice(origin.length)}`, request));
    }
    if (rendering) return new Response("{}", { status: 404 });
    return realFetch(input, init);
  };

  handle = async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    try {
      if (url.href.startsWith(apiPrefix)) {
        // A browser read of the fixture API (the cart, recommendations, suggestions).
        const entry = apiEntry(url.href, request.headers.referer);
        if (!entry) return sendJson(response, 404, { error: "unknown entry" });
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
        const answered = await gallery.answerFixtureApi(entry, new Request(url.href, { method: request.method, body, headers: { "content-type": String(request.headers["content-type"] ?? "") } }));
        response.writeHead(answered.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return response.end(Buffer.from(await answered.arrayBuffer()));
      }
      if (url.pathname.startsWith("/api/v1/")) {
        // A browser read of the API the layout names (the origin): the Referer's entry answers.
        const entry = apiEntry(`${apiPrefix}${REFERER_ENTRY}`, request.headers.referer);
        if (!entry) return sendJson(response, 404, { error: "unknown entry" });
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
        const target = `${apiPrefix}${encodeURIComponent(entry.id)}${url.pathname}${url.search}`;
        const answered = await gallery.answerFixtureApi(entry, new Request(target, { method: request.method, body, headers: { "content-type": String(request.headers["content-type"] ?? "") } }));
        response.writeHead(answered.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return response.end(Buffer.from(await answered.arrayBuffer()));
      }
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
        // Inline, like the production build: a linked sheet can arrive after the
        // first paint in the dev server and shift the page (a CLS the shop never has).
        const sheets = await Promise.all(styles.map(async (href) => {
          const transformed = await vite.transformRequest(`${href}${href.includes("?") ? "&" : "?"}direct`);
          return transformed?.code ?? "";
        }));
        const links = sheets.map((css) => `<style data-gallery-css>${css.replaceAll("</style", "<\\/style")}</style>`).join("");
        html = html.includes("</head>") ? html.replace("</head>", `${links}</head>`) : `${links}${html}`;
        // The dev page is large (every component sheet inline, unminified), so the
        // browser may paint it half parsed: the footer grows as its markup arrives,
        // a layout shift no shopper sees. Hold the first paint until the whole page
        // is parsed, as the production page's single small chunk is.
        html = html.replace("</head>", '<link rel="expect" href="#gallery-page-end" blocking="render"></head>').replace("</body>", '<span id="gallery-page-end" hidden></span></body>');
        response.writeHead(rendered.status === 200 ? 200 : rendered.status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Gallery-Entry": id,
        });
        return response.end(html);
      }
      if (isDevAsset(url.pathname)) {
        return vite.middlewares(request, response, () => sendJson(response, 404, { error: "not found" }));
      }
      // A same-origin storefront route a gallery page calls from the browser
      // (the lazy menu panels, a fragment endpoint): rendered with the fixtures
      // of the entry that asked (its Referer). Anything else, including a
      // prefetch of a real page link, is not part of the gallery.
      if (String(request.headers["sec-purpose"] ?? request.headers.purpose ?? "").includes("prefetch")) {
        response.writeHead(204, { "Cache-Control": "no-store" });
        return response.end();
      }
      const referer = /\/__gallery\/e\/([^/?#]+)/.exec(String(request.headers.referer ?? ""));
      const route = referer ? routeModule(routes, url.pathname) : null;
      const plan = referer && route ? gallery.galleryRenderPlan(decodeURIComponent(referer[1]), origin) : null;
      if (!plan || !route) return sendJson(response, 404, { error: "not in the gallery" });
      const modulePath = route.module;
      const loaded = await vite.ssrLoadModule(modulePath);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
      const rendered = await currentEntry.run(plan.entry, () =>
        runtimeModule.requestRuntime.run(plan.runtime, () =>
          container.renderToResponse(modulePath.endsWith(".ts") ? loaded : loaded.default, {
            request: new Request(url.href, { method: request.method, headers: { cookie: String(request.headers.cookie ?? ""), "content-type": String(request.headers["content-type"] ?? "") }, body }),
            params: route.params,
            locals: {},
            ...(modulePath.endsWith(".ts") ? { routeType: "endpoint" } : {}),
          }),
        ),
      );
      const headers = Object.fromEntries(rendered.headers);
      response.writeHead(rendered.status, { ...headers, "Cache-Control": "no-store" });
      return response.end(Buffer.from(await rendered.arrayBuffer()));
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
