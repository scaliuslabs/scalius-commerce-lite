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
// Snapshots (checkout.discounts and cart.line_prices with `snapshot`): the
// signed-in buyer's record in the declared collection is read and passed in
// with its revision; a checkout.discounts answer's `commit` becomes a
// checked `AppStorageCommit` the order commit writes at that revision. A commit the platform cannot take
// (no snapshot, a guest, an oversized record) invalidates the whole answer:
// a discount must never apply without the write that pays for it.

import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import {
  getPluginRecordVersion,
  listActiveFunctionPlugins,
  prepareAppStorageCommit,
  PluginError,
  type RegisteredPlugin,
} from "@scalius/core/modules/plugins";
import type { AppStorageCommit } from "@scalius/shared/checkout-app-facts";
import {
  PLUGIN_FUNCTION_SCHEMAS,
  PLUGIN_SNAPSHOT_FUNCTION_POINTS,
  type PluginFunctionInput,
  type PluginFunctionOutput,
  type PluginFunctionPoint,
} from "@scalius/shared/plugins";
import type { PluginHost, PluginHostOptions } from "./host";

export interface PluginFunctionResult<P extends PluginFunctionPoint> {
  pluginId: string;
  priority: number;
  output: PluginFunctionOutput<P>;
  /** checkout.discounts: the snapshot write this answer commits with the order. */
  commit?: AppStorageCommit;
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
  const blocked: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < registered.length) {
      const index = next;
      next += 1;
      const { installation, priority } = registered[index]!;
      const declaration = installation.manifest.functions.find((fn) => fn.point === point);
      const snapshot = (PLUGIN_SNAPSHOT_FUNCTION_POINTS as readonly string[]).includes(point)
        ? await readSnapshot(db, installation, declaration?.snapshot, checked.data)
        : undefined;
      const outcome = await host.invokeFunction(installation, point, snapshot ? { ...checked.data, snapshot: snapshot.value } : checked.data);
      if (!outcome.ok || !outcome.value) {
        // Only an approved grant lets an app pause checkout.
        if (declaration?.onError === "block" && installation.grant?.blockingFunctions.includes(point)) blocked.push(installation.pluginId);
        continue;
      }
      const result: PluginFunctionResult<P> = { pluginId: installation.pluginId, priority, output: outcome.value };
      const commit = (outcome.value as { commit?: { record: unknown } }).commit;
      if (commit) {
        const prepared = await prepareCommit(host, installation, snapshot, commit.record);
        if (!prepared) continue;
        result.commit = prepared;
      }
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, registered.length) }, worker));
  if (blocked.length > 0) throw new PluginFunctionsBlockedError(point, blocked.sort());
  return results.filter((result): result is PluginFunctionResult<P> => result !== null);
}

interface SnapshotRead {
  collection: string;
  customerId: string;
  value: { revision: number; data: Record<string, unknown> } | null;
}

/** The signed-in buyer's record in the declared collection; none for a guest or an app without a snapshot. */
async function readSnapshot(
  db: Database,
  installation: RegisteredPlugin["installation"],
  snapshot: { collection: string } | undefined,
  input: unknown,
): Promise<SnapshotRead | undefined> {
  if (!snapshot) return undefined;
  const customerId = (input as { cart?: { customer?: { id?: string } | null } }).cart?.customer?.id;
  if (!customerId) return { collection: snapshot.collection, customerId: "", value: null };
  const record = await getPluginRecordVersion(db, installation.pluginId, snapshot.collection, customerId);
  return { collection: snapshot.collection, customerId, value: record };
}

/** The answer's commit as the order will write it, or null (logged) when the platform cannot take it. */
async function prepareCommit(
  host: PluginHost,
  installation: RegisteredPlugin["installation"],
  snapshot: SnapshotRead | undefined,
  record: unknown,
): Promise<AppStorageCommit | null> {
  const refuse = async (reason: string) => {
    await host.incident(installation, "function:checkout.discounts", `${reason} The answer was skipped.`);
    return null;
  };
  if (!snapshot) return refuse("A commit needs a snapshot declared on checkout.discounts.");
  if (!snapshot.customerId) return refuse("A commit needs a signed-in buyer.");
  const declaration = installation.manifest.storage[snapshot.collection];
  if (!declaration) return refuse(`Storage collection ${snapshot.collection} is not declared.`);
  try {
    return prepareAppStorageCommit({
      pluginId: installation.pluginId,
      collection: snapshot.collection,
      declaration,
      id: snapshot.customerId,
      expectedRevision: snapshot.value?.revision ?? null,
      record,
    });
  } catch (error) {
    if (error instanceof PluginError) return refuse(`The commit record was refused: ${error.message}`);
    throw error;
  }
}
