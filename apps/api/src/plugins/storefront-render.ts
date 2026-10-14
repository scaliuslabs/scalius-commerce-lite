// Checkout and customer-account blocks (docs/platform/PLUGINS.md, "Storefront
// surfaces"): drawn by each app's public route inside the
// `/storefront/app-blocks/<page>` batch part. Theme sections, product blocks
// and skins are components drawn at the edge, never here.
//
// What a cached entry depends on, and how it is declared here:
//
//   plg:<id>                    the installation: status, version, grant, manifest, settings
//   plgs:<id>:<collection>      each storage collection the block declares in `reads`
//   ctx.store                   the business, platform and currency documents
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
import type { PluginRenderStoreFacts } from "@scalius/core/modules/storefront";
import { storeTimeZoneOf } from "../utils/store-time-zone";
import {
  PLUGIN_RENDER_CONCURRENCY,
  PLUGIN_RENDER_RETRY_SECONDS,
  PLUGIN_RENDER_WALL_MS,
  pluginBlockAllowsForms,
  pluginRenderOutputSchema,
  type PluginBlockTarget,
  type PluginRenderContext,
} from "@scalius/shared/plugins";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";
import type { PluginRouteRequest } from "@scalius/plugin-sdk";
import type { PluginHost, PluginHostOptions } from "./host";

/** One block to draw. */
export interface AppBlockRequest {
  pluginId: string;
  type: string;
}

/** One drawn block: sanitized HTML and the target it draws at. */
export interface AppBlockRender {
  pluginId: string;
  type: string;
  target: PluginBlockTarget;
  html: string;
}

export interface AppBlockRenderOptions {
  env: Env;
  ctx: ExecutionContext;
  db: Database;
  /** Active installations and store facts already read in the caller's batch. */
  context: { installations: Map<string, PluginInstallation>; store: PluginRenderStoreFacts };
  /** Test seam: replaces the loader choice. */
  loaderFor?: PluginHostOptions["loaderFor"];
}

/**
 * Draws every block, at most `PLUGIN_RENDER_CONCURRENCY` at once, and returns
 * those that drew something, in request order. Declares every output
 * dependency into the current scope.
 */
export async function renderAppBlocks(requests: readonly AppBlockRequest[], options: AppBlockRenderOptions): Promise<AppBlockRender[]> {
  if (requests.length === 0) return [];
  const { installations, store } = options.context;
  for (const request of requests) deps.plugin(request.pluginId);

  // Blocks whose app is active, approved for storefront surfaces and still declares the type.
  const runnable = requests.flatMap((request) => {
    const installation = installations.get(request.pluginId);
    if (!installation?.grant?.storefrontSurfaces) return [];
    const block = installation.manifest.storefront.blocks.find((entry) => entry.type === request.type);
    if (!block) return [];
    deps.pluginCollections(request.pluginId, block.reads);
    return [{ request, installation, block }];
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

  const results: Array<AppBlockRender | null> = new Array(runnable.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < runnable.length) {
      const index = next;
      next += 1;
      const { request, installation, block } = runnable[index]!;
      results[index] = await renderOne(await sharedHost(), installation, request, block);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLUGIN_RENDER_CONCURRENCY, runnable.length) }, worker));
  return results.filter((result): result is AppBlockRender => result !== null);
}

async function renderOne(
  host: PluginHost,
  installation: PluginInstallation,
  request: AppBlockRequest,
  block: PluginInstallation["manifest"]["storefront"]["blocks"][number],
): Promise<AppBlockRender | null> {
  const render: PluginRenderContext = {
    kind: "block",
    target: block.target,
    type: request.type,
    instanceId: `${request.pluginId}/${request.type}`,
    settings: {},
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
  const source = `route:public/${block.route}`;
  let outcome: Awaited<ReturnType<PluginHost["invokeRoute"]>>;
  try {
    outcome = await host.invokeRoute(installation, "public", block.route, routeRequest, {
      render: { collections: [...block.reads], wallMs: PLUGIN_RENDER_WALL_MS },
    });
  } catch (error) {
    // A platform fault: draw nothing, try again soon.
    console.warn(`[plugins] storefront render could not run (${error instanceof Error ? error.name : "error"})`);
    deps.validUntil(Date.now() + PLUGIN_RENDER_RETRY_SECONDS * 1000);
    return null;
  }
  if (!outcome.ok || !outcome.value) {
    // A throw or a timeout may not happen next time; an invalid answer is the app's (it is logged by the host).
    if (outcome.failure !== "invalid") deps.validUntil(Date.now() + PLUGIN_RENDER_RETRY_SECONDS * 1000);
    return null;
  }
  const { status, body } = outcome.value;
  if (status !== 200) return null;
  const parsed = pluginRenderOutputSchema.safeParse(body);
  if (!parsed.success) {
    await host.reportIncident(installation, source, "A storefront block answers { html }.");
    return null;
  }
  const html = sanitizePluginHtml(parsed.data.html, {
    pluginId: installation.pluginId,
    // A block inside the checkout form may hold no form of its own.
    forms: installation.manifest.storefront.proxy && installation.grant?.publicRoutes === true && pluginBlockAllowsForms(block.target),
  });
  if (!html.ok) {
    await host.reportIncident(installation, source, html.reason === "too_large"
      ? "The block's HTML is over 128 KiB in, or 64 KiB once sanitized."
      : "The block's HTML is nested too deeply or has too many elements.");
    return null;
  }
  if (!html.html.trim()) return null;
  return { pluginId: installation.pluginId, type: request.type, target: block.target, html: html.html };
}
