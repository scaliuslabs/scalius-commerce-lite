// Function points (packages/plugin-sdk/docs/apps.md, "Extension points" 2): checkout
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
// buyer-safe message). Each failed answer counts toward the app's circuit at
// that point (core plugins/function-circuit.ts): after repeated failures the
// circuit opens, checkout applies the same policy without calling the app,
// and the staff are told; a good answer closes it.
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
  clearFunctionInflight,
  FUNCTION_CIRCUIT,
  functionCircuitDirty,
  functionCircuitOpen,
  functionHung,
  listActiveFunctionPlugins,
  markFunctionInflight,
  PluginError,
  recordFunctionFailure,
  recordFunctionSuccess,
  stopPlugin,
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

/**
 * One request's sandboxed function runs, one at a time. A sandboxed run is
 * marked in flight before it starts and cleared after (function-circuit.ts);
 * if two overlapped and one held the thread (a busy loop the isolate's CPU
 * limit does not end, as local development's Worker Loader enforces none),
 * the other's clear would never commit and, after the restart, both apps
 * would look hung. Run one at a time, at most one mark is set per request, so
 * a stale mark names exactly the app that never returned. Bundled runs are
 * in-process code, never marked, and stay concurrent; only sandboxed runs
 * pay the wait. A queue belongs to one request (checkout makes one per
 * request; a call without one gets its own), never to the module.
 */
export type SandboxRunQueue = <T>(run: () => Promise<T>) => Promise<T>;

export function createSandboxRunQueue(): SandboxRunQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
}

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
    /** The request's sandboxed-run queue, shared by every point it runs (absent: one for this call). */
    sandboxRuns?: SandboxRunQueue;
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
  const sandboxRuns = options.sandboxRuns ?? createSandboxRunQueue();
  const results: Array<PluginFunctionResult<P> | null> = new Array(registered.length).fill(null);
  const blocked: string[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Circuit bookkeeping runs after the answer (function-circuit.ts): it never delays checkout.
  const settle = (work: Promise<unknown>) => ctx.waitUntil(work.catch(() => console.warn(`[plugins] function circuit write failed`)));
  let next = 0;
  const worker = async () => {
    while (next < registered.length) {
      const index = next;
      next += 1;
      const registration = registered[index]!;
      const { installation, priority } = registration;
      const declaration = installation.manifest.functions.find((fn) => fn.point === point);
      // Only an approved grant lets an app pause checkout.
      const blocking = declaration?.onError === "block" && Boolean(installation.grant?.blockingFunctions.some((blockingPoint) => blockingPoint === point));
      const fail = () => {
        if (blocking) blocked.push(installation.pluginId);
      };
      // One more failed answer toward the circuit.
      const count = () => {
        settle(recordFunctionFailure(db, { pluginId: installation.pluginId, point }).then((state) => (
          state.opened ? noticeOpenCircuit(db, env, host, installation, point, state, blocking) : undefined
        )));
      };
      // A failed answer: the failure policy now, and a count toward the circuit.
      const failed = () => {
        fail();
        count();
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
      // A run that never returned (it held its thread): stop the app rather than freeze the store again.
      // A stopped app neither answers nor blocks, so it is left out here too.
      if (functionHung(registration.circuit, nowSeconds)) {
        await stopHungApp(db, env, host, installation, point);
        continue;
      }
      // An open circuit: the failure policy at once, without calling the app (or logging again).
      if (functionCircuitOpen(registration.circuit, nowSeconds)) {
        fail();
        continue;
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
        failed();
        continue;
      }
      const reads = readNames ? Object.fromEntries(Object.entries(read.reads).filter(([as]) => readNames.has(as))) : read.reads;
      const invoke = () => host.invokeFunction(installation, point, { ...scopedInput, reads });
      // A sandboxed run is marked in flight first (function-circuit.ts): if it never returns, the next checkout knows.
      // The request runs its sandboxed runs one at a time, so the mark is the only one and is cleared before the next starts.
      const outcome = installation.source === "bundled" ? await invoke() : await sandboxRuns(async () => {
        await markFunctionInflight(db, { pluginId: installation.pluginId, point });
        const answer = await invoke();
        await clearFunctionInflight(db, { pluginId: installation.pluginId, point }).catch(() => console.warn("[plugins] function in-flight clear failed"));
        return answer;
      });
      if (!outcome.ok || !outcome.value) {
        // A run the platform cut short for its own reasons (the app was just updated or stopped) is no failure of the app's.
        if (!outcome.ok && (outcome.failure === "outdated" || outcome.failure === "inactive")) fail();
        else failed();
        continue;
      }
      if (functionCircuitDirty(registration.circuit)) settle(recordFunctionSuccess(db, { pluginId: installation.pluginId, point }));
      const result: PluginFunctionResult<P> = { pluginId: installation.pluginId, priority, output: outcome.value };
      const commit = (outcome.value as { commit?: Array<{ as: string; record: unknown }> }).commit;
      if (commit?.length) {
        const prepared = await prepareCommits(host, installation, point, read, commit);
        if (!prepared) {
          count();
          continue;
        }
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

/**
 * A function's circuit just opened (function-circuit.ts): the app's log says
 * so and the staff are told, once per opening. A blocking function keeps
 * checkout refusing meanwhile, so the notice names the way out.
 */
async function noticeOpenCircuit(
  db: Database,
  env: Env,
  host: PluginHost,
  installation: RegisteredPlugin["installation"],
  point: PluginRunPoint,
  state: { failures: number; openUntil: number | null },
  blocking: boolean,
): Promise<void> {
  const name = installation.manifest.name;
  const minutes = Math.round(FUNCTION_CIRCUIT.openSeconds / 60);
  const consequence = blocking
    ? "It is approved as blocking, so checkout refuses orders until it answers again. Fix the app, or stop it on its page (Stop now) and checkout goes on without it."
    : "Checkout goes on without it meanwhile.";
  await host.incident(
    installation,
    `function:${point}`,
    `${point} failed ${state.failures} times; checkout stops calling it for ${minutes} minutes, then tries it once. ${consequence}`,
  );
  try {
    const { resolveDashboardLink, sendAdminPushNotice } = await import("@scalius/core/modules/notifications");
    await sendAdminPushNotice(db, env, {
      title: blocking ? `${name} is blocking checkout` : `${name} is paused at checkout`,
      body: `Its ${point} answer kept failing. ${consequence}`,
      link: resolveDashboardLink(env, `/admin/apps/${installation.pluginId}`),
      data: { pluginId: installation.pluginId, notificationType: "plugin_function_circuit" },
    });
  } catch {
    console.warn(`[plugins] ${installation.pluginId} circuit notice failed`);
  }
}

/**
 * A sandboxed function run never returned (function-circuit.ts): the app is
 * stopped with its reason, its log says why, and the staff are told. Starting
 * it again (after a fix) is the merchant's call.
 */
async function stopHungApp(
  db: Database,
  env: Env,
  host: PluginHost,
  installation: RegisteredPlugin["installation"],
  point: PluginRunPoint,
): Promise<void> {
  const reason = `Its ${point} function started and never returned, holding the store's Worker. It was stopped so it cannot freeze checkout again.`;
  const stopped = await stopPlugin(db, installation.pluginId, reason).catch(() => false);
  if (!stopped) return;
  await host.incident(installation, `function:${point}`, reason);
  try {
    const { resolveDashboardLink, sendAdminPushNotice } = await import("@scalius/core/modules/notifications");
    await sendAdminPushNotice(db, env, {
      title: `${installation.manifest.name} was stopped`,
      body: `Its ${point} answer never came back. Fix the app, then start it again.`,
      link: resolveDashboardLink(env, `/admin/apps/${installation.pluginId}`),
      data: { pluginId: installation.pluginId, notificationType: "plugin_stopped" },
    });
  } catch {
    console.warn(`[plugins] ${installation.pluginId} stop notice failed`);
  }
}
