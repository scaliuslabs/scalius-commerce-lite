// Function points (docs/platform/PLUGINS.md, "Extension points" 2): checkout
// asks every active plugin that implements a point, in priority order, and
// merges what comes back (core checkout/app-functions.ts). This is the runner
// it calls. With no active implementation the cost is one indexed read that
// returns nothing (or none: checkout passes the registrations it already
// read in its own batch).

import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import { listActiveFunctionPlugins, type RegisteredPlugin } from "@scalius/core/modules/plugins";
import {
  PLUGIN_FUNCTION_SCHEMAS,
  type PluginFunctionInput,
  type PluginFunctionOutput,
  type PluginFunctionPoint,
} from "@scalius/shared/plugins";
import type { PluginHost, PluginHostOptions } from "./host";

export interface PluginFunctionResult<P extends PluginFunctionPoint> {
  pluginId: string;
  priority: number;
  output: PluginFunctionOutput<P>;
}

/** Plugins asked at once; each is CPU-bound and wall-limited, so a few in flight bound latency. */
const CONCURRENCY = 4;

/**
 * Runs `point` for every active implementing plugin and returns the valid
 * outputs, ordered by priority then plugin id. A plugin that throws, times
 * out or returns an invalid output is skipped (fail-open) and logged for the
 * merchant. The input is the platform's own and must match the point's
 * schema; a mismatch is a platform bug and throws. A plugin whose approved
 * grant does not include the point never runs.
 */
export async function runPluginFunctions<P extends PluginFunctionPoint>(
  point: P,
  input: PluginFunctionInput<P>,
  env: Env,
  ctx: ExecutionContext,
  options: {
    db?: Database;
    loaderFor?: PluginHostOptions["loaderFor"];
    /** The point's registrations, already read (checkout reads every point in its own batch). */
    registered?: readonly RegisteredPlugin[];
    /** A host shared by the request's calls (one settings read per plugin). */
    host?: PluginHost;
  } = {},
): Promise<Array<PluginFunctionResult<P>>> {
  const db = options.db ?? getDb(env);
  const registered = (options.registered ?? await listActiveFunctionPlugins(db, point))
    .filter((registration) => registration.name === point && registration.installation.grant?.functions.includes(point));
  if (registered.length === 0) return [];

  const checked = PLUGIN_FUNCTION_SCHEMAS[point].input.safeParse(input);
  if (!checked.success) {
    throw new TypeError(`runPluginFunctions(${point}) received an input that does not match the point's schema.`);
  }
  const host = options.host ?? await (async () => {
    const { PluginHost } = await import("./host");
    return new PluginHost({ env, ctx, db, ...(options.loaderFor ? { loaderFor: options.loaderFor } : {}) });
  })();
  const results: Array<PluginFunctionResult<P> | null> = new Array(registered.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < registered.length) {
      const index = next;
      next += 1;
      const { installation, priority } = registered[index]!;
      const outcome = await host.invokeFunction(installation, point, checked.data);
      if (outcome.ok && outcome.value) results[index] = { pluginId: installation.pluginId, priority, output: outcome.value };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, registered.length) }, worker));
  return results.filter((result): result is PluginFunctionResult<P> => result !== null);
}
