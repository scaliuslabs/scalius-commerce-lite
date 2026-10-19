// Function points (docs/platform/PLUGINS.md, "Extension points" 2): checkout
// asks every active plugin that implements a point, in priority order, and
// merges what comes back (core checkout/app-functions.ts). This is the runner
// it calls. With no active implementation the cost is one indexed read that
// returns nothing (or none: checkout passes the registrations it already
// read in its own batch).
//
// Failure policy (manifest `onError`): a throw, timeout or invalid answer
// leaves the app out (`skip`, the default), or, for an app registered with
// `block` at cart.validate or checkout.payment_methods, stops the run with
// `PluginFunctionsBlockedError` (checkout then refuses with the store's
// buyer-safe message).
//
// Declared reads (manifest `reads`, core checkout/app-reads.ts): each app
// gets its own as `input.reads`, from the request's reads cache (filled by
// the checkout facts batch) or read now in one batch for every app at the
// point. Reads over their bounds count as a failed answer. A
// checkout.discounts answer's `commit` entries become checked
// `AppObjectCommit`s the order commit writes at the revisions read. A commit
// the platform cannot take (an undeclared or per-line read, a key with no id,
// an invalid record) invalidates the whole answer: a discount must never
// apply without the write that pays for it.

import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import {
  listActiveFunctionPlugins,
  PluginError,
  type RegisteredPlugin,
} from "@scalius/core/modules/plugins";
import { prepareAppObjectCommit, ObjectError } from "@scalius/core/modules/objects";
import {
  appReadContextOfInput,
  createAppReadsCache,
  NO_APP_FUNCTION_READS,
  type AppFunctionReadRequest,
  type AppFunctionReadResult,
  type AppReadsCache,
} from "@scalius/core/modules/checkout";
import type { AppObjectCommit } from "@scalius/shared/checkout-app-facts";
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
  /** checkout.discounts: the writes of read records this answer commits with the order. */
  commits?: AppObjectCommit[];
}

/** An app registered with `onError: "block"` could not answer: checkout must stop. */
export class PluginFunctionsBlockedError extends Error {
  constructor(readonly point: PluginFunctionPoint, readonly pluginIds: string[]) {
    super(`Checkout is paused: ${pluginIds.join(", ")} could not answer ${point}.`);
    this.name = "PluginFunctionsBlockedError";
  }
}

/** Plugins asked at once; each is CPU-bound and wall-limited, so a few in flight bound latency. */
const CONCURRENCY = 4;

/** The declared reads of these registrations at `point`. */
export function functionReadRequests(registered: readonly RegisteredPlugin[], point: PluginFunctionPoint): AppFunctionReadRequest[] {
  return registered.flatMap(({ installation }) => {
    const declaration = installation.manifest.functions.find((fn) => fn.point === point);
    return declaration?.reads?.length
      ? [{ pluginId: installation.pluginId, point, reads: declaration.reads, objects: installation.manifest.objects }]
      : [];
  });
}

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
  input: Omit<PluginFunctionInput<P>, "reads">,
  env: Env,
  ctx: ExecutionContext,
  options: {
    db?: Database;
    loaderFor?: PluginHostOptions["loaderFor"];
    /** The point's registrations, already read (checkout reads every point in its own batch). */
    registered?: readonly RegisteredPlugin[];
    /** A host shared by the request's calls (one settings read per plugin). */
    host?: PluginHost;
    /** The request's resolved reads (absent: read here, in one batch). */
    reads?: AppReadsCache;
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
  const requests = functionReadRequests(registered, point);
  const readsCache = requests.length > 0 ? options.reads ?? createAppReadsCache(db) : null;
  const readContext = appReadContextOfInput(checked.data);
  const results: Array<PluginFunctionResult<P> | null> = new Array(registered.length).fill(null);
  const blocked: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < registered.length) {
      const index = next;
      next += 1;
      const { installation, priority } = registered[index]!;
      const declaration = installation.manifest.functions.find((fn) => fn.point === point);
      const fail = () => {
        // Only an approved grant lets an app pause checkout.
        if (declaration?.onError === "block" && installation.grant?.blockingFunctions.includes(point)) blocked.push(installation.pluginId);
      };
      let scopedInput = checked.data as Record<string, unknown>;
      if (point === "buyer.ui") {
        const buyer = checked.data as PluginFunctionInput<"buyer.ui">;
        if (!declaration?.targets?.includes(buyer.target)) continue;
        const prefix = `${installation.pluginId}.`;
        const own = Object.fromEntries(Object.entries(buyer.attributes).filter(([key]) => key.startsWith(prefix)));
        scopedInput = { ...buyer, attributes: Object.fromEntries(Object.entries(own).map(([key, value]) => [key.slice(prefix.length), value])), cart: buyer.cart ? { ...buyer.cart, attributes: own } : null };
      }
      const read: AppFunctionReadResult = readsCache && declaration?.reads?.length
        ? await readsCache.get(requests, readContext, installation.pluginId, point)
        : NO_APP_FUNCTION_READS;
      if (!read.ok) {
        await host.incident(installation, `function:${point}`, `${read.reason} The function did not run.`);
        fail();
        continue;
      }
      const outcome = await host.invokeFunction(installation, point, { ...scopedInput, reads: read.reads });
      if (!outcome.ok || !outcome.value) {
        fail();
        continue;
      }
      const result: PluginFunctionResult<P> = { pluginId: installation.pluginId, priority, output: outcome.value };
      const commit = (outcome.value as { commit?: Array<{ as: string; record: unknown }> }).commit;
      if (commit?.length) {
        const prepared = await prepareCommits(host, installation, point, read, commit);
        if (!prepared) continue;
        result.commits = prepared;
      }
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, registered.length) }, worker));
  if (blocked.length > 0) throw new PluginFunctionsBlockedError(point, blocked.sort());
  return results.filter((result): result is PluginFunctionResult<P> => result !== null);
}

/** The answer's commits as the order will write them, or null (logged) when the platform cannot take one. */
async function prepareCommits(
  host: PluginHost,
  installation: RegisteredPlugin["installation"],
  point: PluginFunctionPoint,
  read: Extract<AppFunctionReadResult, { ok: true }>,
  commits: ReadonlyArray<{ as: string; record: unknown }>,
): Promise<AppObjectCommit[] | null> {
  const refuse = async (reason: string) => {
    await host.incident(installation, `function:${point}`, `${reason} The answer was skipped.`);
    return null;
  };
  const prepared: AppObjectCommit[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    if (seen.has(commit.as)) return refuse(`The answer commits ${commit.as} twice.`);
    seen.add(commit.as);
    const target = read.targets[commit.as];
    if (!target) return refuse(`A commit names ${commit.as}, which is not a single-key object read of this function with a record id (a guest's customer read, an empty attribute or hop, a per-line or custom-field read).`);
    const declaration = installation.manifest.objects[target.object];
    if (!declaration) return refuse(`Storage object ${target.object} is not declared.`);
    try {
      prepared.push(prepareAppObjectCommit({
        pluginId: installation.pluginId,
        object: target.object,
        declaration,
        id: target.id,
        expectedRevision: target.revision,
        record: commit.record,
        context: target.context,
      }));
    } catch (error) {
      if (error instanceof PluginError || error instanceof ObjectError) return refuse(`The commit record for ${commit.as} was refused: ${error.message}`);
      throw error;
    }
  }
  return prepared;
}
