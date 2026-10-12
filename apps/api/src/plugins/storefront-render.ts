// Storefront app output (docs/platform/PLUGINS.md, "Storefront surfaces"):
// the app sections of the homepage, the app blocks of a product page and the
// checkout and customer-account blocks, drawn by each app's public route
// inside the batch part that shows them (`/storefront/homepage`,
// `/storefront/product-apps/<slug>`, `/storefront/app-blocks/<page>`).
//
// What a cached entry depends on, and how it is declared here:
//
//   plg:<id>                    the installation: status, version, grant, manifest, settings
//   plgs:<id>:<collection>      each storage collection the section declares in `reads`
//   theme / p:<id> / set:...    the placement and its values, the product, ctx.store
//
// Generated triggers on the plugin tables advance `plg` and `plgs` keys
// with every committed write (migration 0110). While drawing, the bridge refuses
// everything the keys do not cover (KV, `ctx.api`, `ctx.http`, custom
// fields, messaging, writes, undeclared collections), so a validated entry is
// exactly what the app would draw now, and a cache hit runs no plugin code.
//
// Failure is quiet: an inactive or missing app, a type it no longer declares,
// an invalid answer or HTML over the bounds draws nothing; a run that threw
// or timed out also draws nothing and makes the entry expire after
// `PLUGIN_RENDER_RETRY_SECONDS`, so the app gets another chance without the
// page ever waiting on it twice.

import type { Database } from "@scalius/database/client";
import { deps } from "@scalius/core/cache-deps";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import { readPluginRenderContext, type PluginRenderStoreFacts } from "@scalius/core/modules/storefront";
import { storeTimeZoneOf } from "../utils/store-time-zone";
import {
  EMPTY_PLUGIN_HEAD,
  PLUGIN_RENDER_CONCURRENCY,
  PLUGIN_RENDER_RETRY_SECONDS,
  PLUGIN_RENDER_WALL_MS,
  pluginBlockAllowsForms,
  pluginRenderOutputSchema,
  resolvePluginSettingValues,
  sanitizePluginHead,
  type PluginBlockTarget,
  type PluginHead,
  type PluginRenderContext,
  type PluginSettingValue,
} from "@scalius/shared/plugins";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";
import type { PluginRouteRequest } from "@scalius/plugin-sdk";
import type { PluginHost, PluginHostOptions } from "./host";

/** One app placement to draw. */
export interface AppSurfaceRequest {
  /** The theme's id of the placement (section id or product block id). */
  instanceId: string;
  pluginId: string;
  type: string;
  kind: PluginRenderContext["kind"];
  values: Record<string, PluginSettingValue>;
  product?: PluginRenderContext["product"];
}

/** One drawn placement: sanitized HTML and the head tags its app may add. */
export interface AppSurfaceRender {
  instanceId: string;
  pluginId: string;
  type: string;
  /** Product blocks: where the app puts it. */
  placement: "buy-box" | "below" | null;
  /** Checkout and customer-account blocks: the extension target it draws at. */
  target: PluginBlockTarget | null;
  html: string;
  head: PluginHead;
}

export interface AppSurfaceRenderOptions {
  /** Preview updates retain the previous DOM when a runnable app fails. */
  failOnError?: boolean;
  env: Env;
  ctx: ExecutionContext;
  db: Database;
  /**
   * Active installations and store facts already read in the caller's batch
   * (product-apps reads them with the theme); else read here, in one batch.
   */
  context?: { installations: Map<string, PluginInstallation>; store: PluginRenderStoreFacts };
  /** Test seam: replaces the loader choice. */
  loaderFor?: PluginHostOptions["loaderFor"];
  /** Test seam: observe each run. */
  onInvoke?: (pluginId: string, type: string) => void;
}

/** The manifest entry of a placement, when the app still declares it. */
function surfaceOf(installation: PluginInstallation, request: AppSurfaceRequest) {
  const { storefront } = installation.manifest;
  if (request.kind === "section") {
    const section = storefront.sections.find((entry) => entry.type === request.type);
    return section ? { route: section.route, reads: section.reads, settings: section.settings, placement: null, target: null } : null;
  }
  if (request.kind === "block") {
    const block = storefront.blocks.find((entry) => entry.type === request.type);
    return block ? { route: block.route, reads: block.reads, settings: [], placement: null, target: block.target } : null;
  }
  const block = storefront.productBlocks.find((entry) => entry.type === request.type);
  return block ? { route: block.route, reads: block.reads, settings: block.settings, placement: block.placement, target: null } : null;
}

/**
 * Draws every placement, at most `PLUGIN_RENDER_CONCURRENCY` at once, and
 * returns those that drew something, in request order. Preview callers may
 * opt into failures; published output gracefully omits failed apps. Declares
 * every output dependency into the current scope.
 */
export async function renderAppSurfaces(requests: readonly AppSurfaceRequest[], options: AppSurfaceRenderOptions): Promise<AppSurfaceRender[]> {
  if (requests.length === 0) return [];
  const { installations, store } = options.context
    ?? await readPluginRenderContext(options.db, [...new Set(requests.map((request) => request.pluginId))]);
  for (const request of requests) deps.plugin(request.pluginId);

  // Placements whose app is active, approved for storefront surfaces and still declares the type.
  const runnable = requests.flatMap((request) => {
    const installation = installations.get(request.pluginId);
    if (!installation?.grant?.storefrontSurfaces) return [];
    const surface = surfaceOf(installation, request);
    if (!surface) return [];
    deps.pluginCollections(request.pluginId, surface.reads);
    return [{ request, installation, surface }];
  });
  if (runnable.length === 0) return [];

  let host: Promise<PluginHost> | null = null;
  const sharedHost = () => {
    host ??= import("./host").then(({ PluginHost }) => new PluginHost({
      env: options.env,
      ctx: options.ctx,
      db: options.db,
      ...(options.loaderFor ? { loaderFor: options.loaderFor } : {}),
      store: async () => ({ ...store, url: options.env.STOREFRONT_URL?.trim() || null, timezone: storeTimeZoneOf(options.env) }),
    }));
    return host;
  };

  const results: Array<AppSurfaceRender | null> = new Array(runnable.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < runnable.length) {
      const index = next;
      next += 1;
      const { request, installation, surface } = runnable[index]!;
      results[index] = await renderOne(await sharedHost(), installation, request, surface, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLUGIN_RENDER_CONCURRENCY, runnable.length) }, worker));
  return results.filter((result): result is AppSurfaceRender => result !== null);
}

async function renderOne(
  host: PluginHost,
  installation: PluginInstallation,
  request: AppSurfaceRequest,
  surface: NonNullable<ReturnType<typeof surfaceOf>>,
  options: AppSurfaceRenderOptions,
): Promise<AppSurfaceRender | null> {
  const render: PluginRenderContext = {
    kind: request.kind,
    ...(surface.target ? { target: surface.target } : {}),
    type: request.type,
    instanceId: request.instanceId,
    settings: resolvePluginSettingValues(surface.settings, request.values),
    product: request.product ?? null,
  };
  const routeRequest: PluginRouteRequest = {
    method: "GET",
    subpath: "",
    query: {},
    headers: { accept: "text/html" },
    body: null,
    rawBody: null,
    staffId: null,
    render,
    customer: null,
  };
  options.onInvoke?.(installation.pluginId, request.type);
  const source = `route:public/${surface.route}`;
  let outcome: Awaited<ReturnType<PluginHost["invokeRoute"]>>;
  try {
    outcome = await host.invokeRoute(installation, "public", surface.route, routeRequest, {
      render: { collections: [...surface.reads], wallMs: PLUGIN_RENDER_WALL_MS },
    });
  } catch (error) {
    if (options.failOnError) throw new Error("Preview app render failed");
    // A platform fault: draw nothing, try again soon.
    console.warn(`[plugins] storefront render could not run (${error instanceof Error ? error.name : "error"})`);
    deps.validUntil(Date.now() + PLUGIN_RENDER_RETRY_SECONDS * 1000);
    return null;
  }
  if (!outcome.ok || !outcome.value) {
    if (options.failOnError) throw new Error("Preview app render failed");
    // A throw or a timeout may not happen next time; an invalid answer is the app's (it is logged by the host).
    if (outcome.failure !== "invalid") deps.validUntil(Date.now() + PLUGIN_RENDER_RETRY_SECONDS * 1000);
    return null;
  }
  const { status, body } = outcome.value;
  if (status !== 200) {
    if (options.failOnError && status !== 204) throw new Error("Preview app render failed");
    return null;
  }
  const parsed = pluginRenderOutputSchema.safeParse(body);
  if (!parsed.success) {
    await host.reportIncident(installation, source, "A storefront section answers { html, head? }.");
    if (options.failOnError) throw new Error("Preview app render failed");
    return null;
  }
  const html = sanitizePluginHtml(parsed.data.html, {
    pluginId: installation.pluginId,
    // A block inside the checkout form may hold no form of its own.
    forms: installation.manifest.storefront.proxy && installation.grant?.publicRoutes === true
      && (surface.target === null || pluginBlockAllowsForms(surface.target)),
  });
  if (!html.ok) {
    await host.reportIncident(installation, source, html.reason === "too_large"
      ? "The section's HTML is over 128 KiB in, or 64 KiB once sanitized."
      : "The section's HTML is nested too deeply or has too many elements.");
    if (options.failOnError) throw new Error("Preview app render failed");
    return null;
  }
  // Checkout and account pages are never indexed: blocks add no head tags.
  const head = installation.manifest.storefront.head && parsed.data.head !== undefined && surface.target === null
    ? sanitizePluginHead(parsed.data.head)
    : { ...EMPTY_PLUGIN_HEAD, meta: [], jsonLd: [] };
  if (!html.html.trim() && head.meta.length === 0 && head.jsonLd.length === 0) return null;
  return {
    instanceId: request.instanceId,
    pluginId: installation.pluginId,
    type: request.type,
    placement: surface.placement,
    target: surface.target,
    html: html.html,
    head,
  };
}
