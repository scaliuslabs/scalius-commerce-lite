// The apps a checkout request asks (core checkout/app-functions.ts): built
// once per request from the active function registrations the request
// already read in its own batch, so a store with no app implementing a point
// pays nothing beyond that empty read. Outputs are memoized per point and
// input for the request (the same quote gives the same app outcome), never
// across requests. Order placement builds its own and runs the apps again.

import type { Database } from "@scalius/database/client";
import {
  resolveActiveFunctionRegistrations,
  writePluginLogs,
  type ActiveFunctionRegistrationRow,
  type RegisteredPlugin,
} from "@scalius/core/modules/plugins";
import {
  CHECKOUT_APP_UNAVAILABLE_REASON,
  createAppReadsCache,
  readCheckoutCopy,
  type CheckoutAppFunctionResult,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import { ValidationError } from "@scalius/core/errors";
import { PLUGIN_EXTENSION_RUN, PLUGIN_FUNCTION_POINTS, type PluginFunctionInput, type PluginFunctionPoint, type PluginRunPoint } from "@scalius/shared/plugins";
import type { PluginHost, PluginHostOptions } from "./host";
import { prepareBuyerUiBlocks } from "./buyer-ui";
import { functionReadRequests, PluginFunctionsBlockedError, runPluginFunctions } from "./functions";

export interface CheckoutAppFunctionsOptions {
  env: Env;
  ctx: ExecutionContext | undefined;
  db: Database;
  /** `selectActiveFunctionRegistrations` rows, or already-resolved registrations. */
  registrations: readonly ActiveFunctionRegistrationRow[] | readonly RegisteredPlugin[];
  /** Test seam: replaces the loader choice. */
  loaderFor?: PluginHostOptions["loaderFor"];
}

function isResolved(value: readonly ActiveFunctionRegistrationRow[] | readonly RegisteredPlugin[]): value is readonly RegisteredPlugin[] {
  const first = value[0] as RegisteredPlugin | ActiveFunctionRegistrationRow | undefined;
  // A resolved installation carries its parsed manifest; a raw row its JSON.
  return !first || "manifest" in first.installation;
}

/** A context for plugin work outside a Worker invocation (tests, scripts). */
function contextOf(ctx: ExecutionContext | undefined): ExecutionContext {
  return ctx ?? ({ waitUntil: () => undefined, passThroughOnException: () => undefined, props: {}, exports: {} } as unknown as ExecutionContext);
}

export function createCheckoutAppFunctions(options: CheckoutAppFunctionsOptions): CheckoutAppFunctions {
  const registrations = (isResolved(options.registrations)
    ? [...options.registrations]
    : resolveActiveFunctionRegistrations(options.registrations as readonly ActiveFunctionRegistrationRow[]))
    // The approved grant decides: an app runs only at the points (and UI slots) it was approved for.
    .filter((registration) => registration.name === PLUGIN_EXTENSION_RUN
      ? (registration.installation.grant?.extensions ?? []).length > 0
      : (PLUGIN_FUNCTION_POINTS as readonly string[]).includes(registration.name)
        && registration.installation.grant?.functions.includes(registration.name as PluginFunctionPoint));
  const attributeApps = new Map(registrations.map(({ installation }) => [installation.pluginId, { appId: installation.pluginId, fields: installation.manifest.checkout?.attributes ?? [] }]));
  const attributes = [...attributeApps.values()];
  // Purchase options (manifest `checkout.purchaseOptions`): what a cart line may name; core prices nothing for them.
  const purchaseOptions = [...new Map(registrations.map(({ installation }) => [installation.pluginId, { appId: installation.pluginId, options: installation.manifest.checkout?.purchaseOptions ?? [] }])).values()]
    .filter((app) => app.options.length > 0);
  const points = new Set(registrations.map((registration) => registration.name as PluginRunPoint));
  if (points.size === 0) return { points, attributes, purchaseOptions, buyerUi: async () => [], run: async () => [], report: () => undefined };

  const ctx = contextOf(options.ctx);
  const memo = new Map<string, Promise<unknown[]>>();
  // Declared reads, one cache per request: facts batches fill it, calls read from it.
  const reads = createAppReadsCache(options.db);
  let host: Promise<PluginHost> | null = null;
  const sharedHost = () => {
    host ??= import("./host").then(({ PluginHost }) => new PluginHost({
      env: options.env,
      ctx,
      db: options.db,
      ...(options.loaderFor ? { loaderFor: options.loaderFor } : {}),
    }));
    return host;
  };

  const runtime: CheckoutAppFunctions = {
    points,
    attributes,
    purchaseOptions,
    reads,
    readRequests(wanted) {
      return wanted.flatMap((point) => functionReadRequests(registrations.filter((registration) => registration.name === point), point));
    },
    async buyerUi(input) {
      if (!points.has(PLUGIN_EXTENSION_RUN)) return [];
      const blocks = [];
      for (const target of input.targets) {
        const results = await runtime.run(PLUGIN_EXTENSION_RUN, { target, language: input.language ?? "en", locale: input.locale ?? "en", currency: input.currency, cart: input.cart ?? null, attributes: input.attributes ?? {}, order: input.order ?? null, customer: input.customer ?? (input.cart?.customer ? { id: input.cart.customer.id } : null) });
        for (const result of results) {
          if (!result.output.ui) continue;
          const installation = registrations.find((entry) => entry.installation.pluginId === result.pluginId)!.installation;
          const prefix = `${result.pluginId}.`;
          const values = Object.fromEntries(Object.entries(input.attributes ?? {}).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
          blocks.push({ appId: result.pluginId, releaseId: installation.bundleSha256, target, ui: result.output.ui.root, attributes: installation.manifest.checkout?.attributes ?? [], values });
        }
      }
      try { return await prepareBuyerUiBlocks(options.db, blocks.slice(0, 12), registrations, options.env.CDN_DOMAIN_URL); } catch { return []; }
    },
    run<P extends PluginRunPoint>(point: P, input: Omit<PluginFunctionInput<P>, "reads">): Promise<Array<CheckoutAppFunctionResult<P>>> {
      if (!points.has(point)) return Promise.resolve([]);
      const key = `${point}\u0000${JSON.stringify(input)}`;
      let pending = memo.get(key) as Promise<Array<CheckoutAppFunctionResult<P>>> | undefined;
      if (!pending) {
        const forPoint = registrations.filter((registration) => registration.name === point);
        const names = new Map(forPoint.map((registration) => [registration.installation.pluginId, registration.installation.manifest.name]));
        // An app the store approved as blocking here: no answer at all must stop checkout too.
        const blocking = forPoint.some((registration) => registration.installation.grant?.blockingFunctions.some((blockingPoint) => blockingPoint === point)
          && registration.installation.manifest.functions.some((fn) => fn.point === point && fn.onError === "block"));
        pending = sharedHost()
          .then((shared) => runPluginFunctions(point, input, options.env, ctx, { db: options.db, registered: forPoint, host: shared, reads }))
          .then((results) => results.map((result) => ({ ...result, appName: names.get(result.pluginId) ?? result.pluginId })))
          .catch(async (error: unknown) => {
            // An app the store made blocking could not answer: checkout stops, with the store's words.
            if (!(error instanceof PluginFunctionsBlockedError)) {
              console.error(`[plugins] checkout function ${point} could not run: ${error instanceof Error ? error.name : "error"}`);
            }
            // A blocking app stops checkout whether the app or the platform failed (fail closed).
            if (error instanceof PluginFunctionsBlockedError || blocking) {
              throw new ValidationError(await readCheckoutCopy(options.db, "checkoutAppUnavailableText"), {
                reason: CHECKOUT_APP_UNAVAILABLE_REASON,
              });
            }
            // Otherwise a platform fault must not take checkout down: no app output (fail-open).
            return [];
          });
        memo.set(key, pending);
      }
      return pending;
    },
    report(pluginId, point, message) {
      const write = writePluginLogs(options.db, pluginId, [{ level: "warn", source: `function:${point}`, message: message.slice(0, 500) }])
        .catch(() => console.warn(`[plugins] ${pluginId} log write failed`));
      if (options.ctx) options.ctx.waitUntil(write);
    },
  };
  return runtime;
}
