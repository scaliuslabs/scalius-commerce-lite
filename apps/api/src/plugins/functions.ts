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
//
// Storefront extensions (manifest `storefront.extensions`) render through
// this runner under PLUGIN_EXTENSION_RUN: an app runs for a UI slot it
// declares and the grant approved, with the reads that slot declares.
//
// Customer roles (customer-roles.ts): the cart is built once for every app,
// so `cart.customer.roles` is filled in here per app, each app only its own.
// They are read once (one indexed read for every app at the point, or once
// per checkout request through `roles`) and only when a signed-in buyer
// meets at least one app that runs: a guest or a store without app functions
// reads nothing more.

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
  PLUGIN_EXTENSION_RUN,
  pluginRunSchemas,
  pluginRunSource,
  type FunctionReadDeclaration,
  type PluginFunctionInput,
  type PluginFunctionOutput,
  type PluginRunPoint,
} from "@scalius/shared/plugins";
import type { PluginCustomerRole } from "@scalius/shared/plugins/customer-roles";
import type { PluginHost, PluginHostOptions } from "./host";

export interface PluginFunctionResult<P extends PluginRunPoint> {
  pluginId: string;
  priority: number;
  output: PluginFunctionOutput<P>;
  /** checkout.discounts: the writes of read records this answer commits with the order. */
  commits?: AppObjectCommit[];
}

/** An app registered with `onError: "block"` could not answer: checkout must stop. */
export class PluginFunctionsBlockedError extends Error {
  constructor(readonly point: PluginRunPoint, readonly pluginIds: string[]) {
    super(`Checkout is paused: ${pluginIds.join(", ")} could not answer ${point}.`);
    this.name = "PluginFunctionsBlockedError";
  }
}

/** One signed-in buyer's roles by app: what a request reads once for its function runs. */
export type FunctionCustomerRoles = (customerId: string, pluginIds: readonly string[]) => Promise<ReadonlyMap<string, PluginCustomerRole[]>>;

/** The signed-in buyer of a function input's cart (null for guests and carts without one). */
function cartCustomerId(input: unknown): string | null {
  const cart = (input as { cart?: { customer?: { id?: unknown } | null } | null } | null)?.cart;
  const id = cart?.customer?.id;
  return typeof id === "string" ? id : null;
}

/** The input with `cart.customer.roles` set to one app's roles. */
function withCustomerRoles(input: Record<string, unknown>, roles: readonly PluginCustomerRole[]): Record<string, unknown> {
  const cart = input.cart as { customer?: Record<string, unknown> | null } | null | undefined;
  if (!cart?.customer) return input;
  return { ...input, cart: { ...cart, customer: { ...cart.customer, roles: roles.map((entry) => ({ role: entry.role, ref: entry.ref })) } } };
}

/** One app's accepted checkout attributes (`<app id>.<key>`), out of every active app's. */
function ownAttributes(attributes: Readonly<Record<string, string>>, pluginId: string): Record<string, string> {
  const prefix = `${pluginId}.`;
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith(prefix)));
}

/**
 * The input with `cart.attributes` narrowed to one app's own answers. Buyer
 * answers are free text the buyer gave one app (a gift message), so another
 * app's function never reads them: reading them would be a declared,
 * consented read, which the platform does not offer. Core cart facts stay.
 */
function withOwnCartAttributes(input: Record<string, unknown>, pluginId: string): Record<string, unknown> {
  const cart = input.cart as { attributes?: Record<string, string> } | null | undefined;
  if (!cart?.attributes) return input;
  return { ...input, cart: { ...cart, attributes: ownAttributes(cart.attributes, pluginId) } };
}

/** Plugins asked at once; each is CPU-bound and wall-limited, so a few in flight bound latency. */
const CONCURRENCY = 4;

/** An app's declared reads at `point`: its function's, or every read its extensions declare (one `as`, one read). */
function declaredReads(installation: RegisteredPlugin["installation"], point: PluginRunPoint): FunctionReadDeclaration[] {
  if (point !== PLUGIN_EXTENSION_RUN) return installation.manifest.functions.find((fn) => fn.point === point)?.reads ?? [];
  const byName = new Map<string, FunctionReadDeclaration>();
  for (const extension of installation.manifest.storefront.extensions) {
    for (const read of extension.reads) if (!byName.has(read.as)) byName.set(read.as, read);
  }
  return [...byName.values()];
}

/** Whether the approved grant lets the app run at `point` (an extension: at least one approved slot). */
function grantAllows(installation: RegisteredPlugin["installation"], point: PluginRunPoint): boolean {
  return point === PLUGIN_EXTENSION_RUN
    ? (installation.grant?.extensions ?? []).length > 0
    : Boolean(installation.grant?.functions.includes(point));
}

/** The declared reads of these registrations at `point`. */
export function functionReadRequests(registered: readonly RegisteredPlugin[], point: PluginRunPoint): AppFunctionReadRequest[] {
  return registered.flatMap(({ installation }) => {
    const reads = declaredReads(installation, point);
    return reads.length
      ? [{ pluginId: installation.pluginId, point, reads, objects: installation.manifest.objects }]
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
export async function runPluginFunctions<P extends PluginRunPoint>(
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
    /** The request's customer-roles read (absent: read here, once, for the point's apps). */
    roles?: FunctionCustomerRoles;
  } = {},
): Promise<Array<PluginFunctionResult<P>>> {
  const db = options.db ?? getDb(env);
  const registered = (options.registered ?? await listActiveFunctionPlugins(db, point))
    .filter((registration) => registration.name === point && grantAllows(registration.installation, point));
  if (registered.length === 0) return [];

  const checked = pluginRunSchemas(point).input.safeParse(input);
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
  // A signed-in buyer's roles, by app: one read for every app at the point, when the first app runs.
  const customerId = cartCustomerId(checked.data);
  let rolesByApp: Promise<ReadonlyMap<string, PluginCustomerRole[]>> | null = null;
  const rolesOf = async (pluginId: string): Promise<PluginCustomerRole[] | null> => {
    if (!customerId) return null;
    const apps = registered.map((registration) => registration.installation.pluginId);
    rolesByApp ??= options.roles
      ? options.roles(customerId, apps)
      : import("./customer-roles").then(({ pluginCustomerRolesByApp }) => pluginCustomerRolesByApp(db, customerId, apps));
    return (await rolesByApp).get(pluginId) ?? [];
  };
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
        if (declaration?.onError === "block" && installation.grant?.blockingFunctions.some((blockingPoint) => blockingPoint === point)) blocked.push(installation.pluginId);
      };
      // An app sees only its own buyer answers: `cart.attributes` keeps the
      // `<app id>.<key>` entries of this app, never another app's.
      let scopedInput = withOwnCartAttributes(checked.data as Record<string, unknown>, installation.pluginId);
      // An extension sees only the reads its own slot declares.
      let readNames: ReadonlySet<string> | null = null;
      if (point === PLUGIN_EXTENSION_RUN) {
        const buyer = checked.data as PluginFunctionInput<typeof PLUGIN_EXTENSION_RUN>;
        const extension = installation.manifest.storefront.extensions.find((entry) => entry.target === buyer.target);
        if (!extension || !installation.grant?.extensions.includes(buyer.target)) continue;
        readNames = new Set(extension.reads.map((read) => read.as));
        const prefix = `${installation.pluginId}.`;
        const own = ownAttributes(buyer.attributes, installation.pluginId);
        scopedInput = { ...scopedInput, attributes: Object.fromEntries(Object.entries(own).map(([key, value]) => [key.slice(prefix.length), value])) };
      }
      // Each app sees only the roles it granted.
      const roles = await rolesOf(installation.pluginId);
      if (roles) scopedInput = withCustomerRoles(scopedInput, roles);
      const wantsReads = readNames ? readNames.size > 0 : Boolean(declaration?.reads?.length);
      const read: AppFunctionReadResult = readsCache && wantsReads
        ? await readsCache.get(requests, readContext, installation.pluginId, point)
        : NO_APP_FUNCTION_READS;
      if (!read.ok) {
        await host.incident(installation, pluginRunSource(point, scopedInput), `${read.reason} The function did not run.`);
        fail();
        continue;
      }
      const reads = readNames ? Object.fromEntries(Object.entries(read.reads).filter(([as]) => readNames.has(as))) : read.reads;
      const outcome = await host.invokeFunction(installation, point, { ...scopedInput, reads });
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
  point: PluginRunPoint,
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
