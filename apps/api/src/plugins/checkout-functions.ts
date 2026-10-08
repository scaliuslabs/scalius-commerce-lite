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
  readCheckoutCopy,
  type CheckoutAppFunctionResult,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import { ValidationError } from "@scalius/core/errors";
import { PLUGIN_FUNCTION_POINTS, type PluginFunctionInput, type PluginFunctionPoint } from "@scalius/shared/plugins";
import type { PluginHost, PluginHostOptions } from "./host";
import { PluginFunctionsBlockedError, runPluginFunctions } from "./functions";

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
    // The approved grant decides: an app runs only at the points it was approved for.
    .filter((registration) => (PLUGIN_FUNCTION_POINTS as readonly string[]).includes(registration.name)
      && registration.installation.grant?.functions.includes(registration.name as PluginFunctionPoint));
  const points = new Set(registrations.map((registration) => registration.name as PluginFunctionPoint));
  if (points.size === 0) return { points, run: async () => [], report: () => undefined };

  const ctx = contextOf(options.ctx);
  const memo = new Map<string, Promise<unknown[]>>();
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

  return {
    points,
    run<P extends PluginFunctionPoint>(point: P, input: PluginFunctionInput<P>): Promise<Array<CheckoutAppFunctionResult<P>>> {
      if (!points.has(point)) return Promise.resolve([]);
      const key = `${point}\u0000${JSON.stringify(input)}`;
      let pending = memo.get(key) as Promise<Array<CheckoutAppFunctionResult<P>>> | undefined;
      if (!pending) {
        const forPoint = registrations.filter((registration) => registration.name === point);
        const names = new Map(forPoint.map((registration) => [registration.installation.pluginId, registration.installation.manifest.name]));
        // An app the store approved as blocking here: no answer at all must stop checkout too.
        const blocking = forPoint.some((registration) => registration.installation.grant?.blockingFunctions.includes(point)
          && registration.installation.manifest.functions.some((fn) => fn.point === point && fn.onError === "block"));
        pending = sharedHost()
          .then((shared) => runPluginFunctions(point, input, options.env, ctx, { db: options.db, registered: forPoint, host: shared }))
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
}
