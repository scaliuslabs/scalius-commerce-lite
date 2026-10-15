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
// signed-in buyer's record in the declared object is read and passed in
// with its revision; a checkout.discounts answer's `commit` becomes a
// checked `AppObjectCommit` the order commit writes at that revision. A commit the platform cannot take
// (no snapshot, a guest, an oversized record) invalidates the whole answer:
// a discount must never apply without the write that pays for it.

import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import {
  listActiveFunctionPlugins,
  PluginError,
  type RegisteredPlugin,
} from "@scalius/core/modules/plugins";
import { getObjectRecordVersion, prepareAppObjectCommit, ObjectError } from "@scalius/core/modules/objects";
import type { AppObjectCommit } from "@scalius/shared/checkout-app-facts";
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
  commit?: AppObjectCommit;
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
    snapshots?: Map<string, Promise<SnapshotRead["value"]>>;
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
      let scopedInput = checked.data;
      if (point === "buyer.ui") {
        const buyer = checked.data as PluginFunctionInput<"buyer.ui">;
        if (!declaration?.targets?.includes(buyer.target)) continue;
        const prefix = `${installation.pluginId}.`;
        const own = Object.fromEntries(Object.entries(buyer.attributes).filter(([key]) => key.startsWith(prefix)));
        scopedInput = { ...buyer, attributes: Object.fromEntries(Object.entries(own).map(([key, value]) => [key.slice(prefix.length), value])), cart: buyer.cart ? { ...buyer.cart, attributes: own } : null };
      }
      const snapshot = (PLUGIN_SNAPSHOT_FUNCTION_POINTS as readonly string[]).includes(point)
        ? await readSnapshot(db, installation, declaration?.snapshot, scopedInput, options.snapshots)
        : undefined;
      const outcome = await host.invokeFunction(installation, point, snapshot ? { ...scopedInput, snapshot: snapshot.value } : scopedInput);
      if (!outcome.ok || !outcome.value) {
        // Only an approved grant lets an app pause checkout.
        if (declaration?.onError === "block" && installation.grant?.blockingFunctions.includes(point)) blocked.push(installation.pluginId);
        continue;
      }
      const result: PluginFunctionResult<P> = { pluginId: installation.pluginId, priority, output: outcome.value };
      const commit = (outcome.value as { commit?: { record: unknown } }).commit;
      if (commit) {
        const prepared = await prepareCommit(host, installation, snapshot, commit.record, checked.data);
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
  object: string;
  customerId: string;
  value: { revision: number; data: Record<string, unknown> } | null;
}

/** The signed-in buyer's record in the declared object; none for a guest or an app without a snapshot. */
async function readSnapshot(
  db: Database,
  installation: RegisteredPlugin["installation"],
  snapshot: { object: string } | undefined,
  input: unknown,
  snapshots?: Map<string, Promise<SnapshotRead["value"]>>,
): Promise<SnapshotRead | undefined> {
  if (!snapshot) return undefined;
  const buyer = input as { cart?: { customer?: { id?: string } | null }; customer?: { id?: string } | null };
  const customerId = buyer.cart?.customer?.id ?? buyer.customer?.id;
  if (!customerId) return { object: snapshot.object, customerId: "", value: null };
  const key = `${installation.pluginId}\0${snapshot.object}\0${customerId}`;
  let record = snapshots?.get(key);
  if (!record) {
    record = getObjectRecordVersion(db, installation.pluginId, snapshot.object, customerId);
    snapshots?.set(key, record);
  }
  return { object: snapshot.object, customerId, value: await record };
}

/** The answer's commit as the order will write it, or null (logged) when the platform cannot take it. */
async function prepareCommit(
  host: PluginHost,
  installation: RegisteredPlugin["installation"],
  snapshot: SnapshotRead | undefined,
  record: unknown,
  input: unknown,
): Promise<AppObjectCommit | null> {
  const refuse = async (reason: string) => {
    await host.incident(installation, "function:checkout.discounts", `${reason} The answer was skipped.`);
    return null;
  };
  if (!snapshot) return refuse("A commit needs a snapshot declared on checkout.discounts.");
  if (!snapshot.customerId) return refuse("A commit needs a signed-in buyer.");
  const declaration = installation.manifest.objects[snapshot.object];
  if (!declaration) return refuse(`Storage object ${snapshot.object} is not declared.`);
  const cart = (input as { cart?: { currency: string; decimalPlaces: number } }).cart;
  try {
    return prepareAppObjectCommit({
      pluginId: installation.pluginId,
      object: snapshot.object,
      declaration,
      id: snapshot.customerId,
      expectedRevision: snapshot.value?.revision ?? null,
      record,
      ...(cart ? { context: { currencyCode: cart.currency, decimalPlaces: cart.decimalPlaces } } : {}),
    });
  } catch (error) {
    if (error instanceof PluginError || error instanceof ObjectError) return refuse(`The commit record was refused: ${error.message}`);
    throw error;
  }
}
