// The apps a checkout request asks (core checkout/app-functions.ts): built
// once per request from the active function registrations the request
// already read in its own batch, so a store with no app implementing a point
// pays nothing beyond that empty read. Outputs are memoized per point and
// input for the request (the same quote gives the same app outcome), never
// across requests. Order placement builds its own and runs the apps again.

import type { Database } from "@scalius/database/client";
import {
  orderFunctionRegistrations,
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
import { CHECKOUT_APP_BUDGET_MS, createSandboxRuns, functionReadRequests, PluginFunctionsBlockedError, runPluginFunctions, type FunctionCustomerRoles } from "./functions";
import type { PluginCustomerRole } from "@scalius/shared/plugins/customer-roles";
import { withBuyerUploadBounds } from "@scalius/shared/buyer-uploads";
import { localizedCheckoutAttributes, localizedPurchaseOptions, pluginTextChain } from "@scalius/shared/plugins/manifest-text";
import { appLineInputsInLanguage } from "@scalius/shared/plugins/line-input-text";
import { isStoreLocale, presenceLocale } from "@scalius/shared/translations";

export interface CheckoutAppFunctionsOptions {
  env: Env;
  ctx: ExecutionContext | undefined;
  db: Database;
  /** `selectActiveFunctionRegistrations` rows, or already-resolved registrations. */
  registrations: readonly ActiveFunctionRegistrationRow[] | readonly RegisteredPlugin[];
  /** Test seam: replaces the loader choice. */
  loaderFor?: PluginHostOptions["loaderFor"];
  /**
   * The buyer's page language (`requestBuyerLanguage`): the presence the
   * order or quote comes from. Absent: the store's default language.
   */
  language?: string | null;
  /**
   * A buyer's checkout (its quote or its order): `cart.validate` apps count
   * the checkouts they refuse and clear the count on one they accept, so the
   * merchant hears of an app refusing every checkout. Not a cart page's
   * check, where a buyer has yet to answer the app, nor a staff order.
   */
  countRefusals?: boolean;
  /** Test seam: the request's app budget (`CHECKOUT_APP_BUDGET_MS`). */
  budgetMs?: number;
}

/**
 * The language a checkout request speaks to the buyer: its presence's
 * locale (`bn` for `/bn/`), else the page language the storefront names
 * (`x-storefront-language`), else none (the store's default).
 */
export function requestBuyerLanguage(presence: string | null | undefined, pageLanguage?: string | null): string | null {
  const scoped = presenceLocale(presence);
  if (scoped) return scoped;
  const language = pageLanguage?.trim().toLowerCase().split("-")[0];
  return language && isStoreLocale(language) ? language : null;
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
  const active = isResolved(options.registrations)
    ? orderFunctionRegistrations(options.registrations)
    : resolveActiveFunctionRegistrations(options.registrations as readonly ActiveFunctionRegistrationRow[]);
  // The buyer's language: the page's, else the store's default (read with the registrations).
  // Every word an app shows the buyer here falls back through `translationChain()`.
  const defaultLocale = active[0]?.storeLocale?.trim().toLowerCase() || "en";
  const language = options.language ?? defaultLocale;
  const chains = new Map<string, ReturnType<typeof pluginTextChain>>();
  const textOf = (installation: (typeof active)[number]["installation"]) => {
    let chain = chains.get(installation.pluginId);
    if (!chain) chains.set(installation.pluginId, chain = pluginTextChain(installation.manifest.translations, { locale: language, defaultLocale }));
    return chain;
  };
  // Purchase options (manifest `checkout.purchaseOptions`): what a cart line may
  // name, from every app checkout reads (a function or a payment provider: the
  // layout's `purchaseOptions` offers the same); core prices nothing for them.
  const purchaseOptions = [...new Map(active.filter(({ installation }) => installation.grant).map(({ installation }) => [installation.pluginId, { appId: installation.pluginId, options: localizedPurchaseOptions(installation.manifest.checkout?.purchaseOptions ?? [], textOf(installation)) }])).values()]
    .filter((app) => app.options.length > 0);
  // Line inputs (manifest `checkout.lineInputs`): what a cart line may carry
  // beside the product's own inputs, read from the same apps; core prices nothing for them.
  // The labels the buyer sees are the ones the order line freezes: the merchant's
  // words where an input names a setting for them, with their revision.
  const lineInputs = [...new Map(active.filter(({ installation }) => installation.grant).map(({ installation }) => [installation.pluginId, { appId: installation.pluginId, inputs: appLineInputsInLanguage(installation.manifest.checkout?.lineInputs ?? [], { settings: installation.manifest.settings, storedSettings: installation.storedSettings }, textOf(installation), { locale: language, defaultLocale }).map((input) => withBuyerUploadBounds(input)) }])).values()]
    .filter((app) => app.inputs.length > 0);
  const registrations = active
    // The approved grant decides: an app runs only at the points (and UI slots) it was approved for.
    .filter((registration) => registration.name === PLUGIN_EXTENSION_RUN
      ? (registration.installation.grant?.extensions ?? []).length > 0
      : (PLUGIN_FUNCTION_POINTS as readonly string[]).includes(registration.name)
        && registration.installation.grant?.functions.includes(registration.name as PluginFunctionPoint));
  const attributeApps = new Map(registrations.map(({ installation }) => [installation.pluginId, { appId: installation.pluginId, fields: localizedCheckoutAttributes(installation.manifest.checkout?.attributes ?? [], textOf(installation)).map((field) => withBuyerUploadBounds(field)) }]));
  const attributes = [...attributeApps.values()];
  const points = new Set(registrations.map((registration) => registration.name as PluginRunPoint));
  if (points.size === 0) return { points, attributes, purchaseOptions, lineInputs, language, buyerUi: async () => [], run: async () => [], report: () => undefined };

  const ctx = contextOf(options.ctx);
  const memo = new Map<string, Promise<unknown[]>>();
  // One budget for the request, from its first app run: every point and wave shares it (functions.ts).
  let deadline: number | null = null;
  const requestDeadline = () => deadline ??= Date.now() + (options.budgetMs ?? CHECKOUT_APP_BUDGET_MS);
  // Points run concurrently; the request's sandboxed runs share one bounded set of slots (functions.ts).
  const sandboxRuns = createSandboxRuns(registrations
    .filter((registration) => registration.installation.source !== "bundled")
    .map((registration) => registration.installation.pluginId));
  // Declared reads, one cache per request: facts batches fill it, calls read from it.
  const reads = createAppReadsCache(options.db);
  // The signed-in buyer's roles for every app of the request: one read, at the first app run that needs it.
  const roleApps = [...new Set(registrations.map((registration) => registration.installation.pluginId))];
  let rolesRead: { customerId: string; roles: Promise<ReadonlyMap<string, PluginCustomerRole[]>> } | null = null;
  const roles: FunctionCustomerRoles = (customerId) => {
    if (rolesRead?.customerId !== customerId) {
      rolesRead = {
        customerId,
        roles: import("./customer-roles").then(({ pluginCustomerRolesByApp }) => pluginCustomerRolesByApp(options.db, customerId, roleApps)),
      };
    }
    return rolesRead.roles;
  };
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
    lineInputs,
    language,
    reads,
    readRequests(wanted) {
      return wanted.flatMap((point) => functionReadRequests(registrations.filter((registration) => registration.name === point), point));
    },
    async buyerUi(input) {
      if (!points.has(PLUGIN_EXTENSION_RUN)) return [];
      const blocks = [];
      for (const target of input.targets) {
        const results = await runtime.run(PLUGIN_EXTENSION_RUN, { target, language: input.language ?? language, locale: input.locale ?? language, currency: input.currency, cart: input.cart ?? null, attributes: input.attributes ?? {}, order: input.order ?? null, customer: input.customer ?? (input.cart?.customer ? { id: input.cart.customer.id } : null) });
        for (const result of results) {
          if (!result.output.ui) continue;
          const installation = registrations.find((entry) => entry.installation.pluginId === result.pluginId)!.installation;
          const prefix = `${result.pluginId}.`;
          const values = Object.fromEntries(Object.entries(input.attributes ?? {}).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
          blocks.push({ appId: result.pluginId, releaseId: installation.bundleSha256, target, ui: result.output.ui.root, attributes: attributeApps.get(result.pluginId)?.fields ?? [], values });
        }
      }
      try { return await prepareBuyerUiBlocks(options.db, blocks.slice(0, 12), registrations, options.env.CDN_DOMAIN_URL); } catch { return []; }
    },
    run<P extends PluginRunPoint>(point: P, given: Omit<PluginFunctionInput<P>, "reads">): Promise<Array<CheckoutAppFunctionResult<P>>> {
      if (!points.has(point)) return Promise.resolve([]);
      // Every run hears the buyer's language (an extension's input already names its page's).
      const input = point === PLUGIN_EXTENSION_RUN ? given : { ...given, language: (given as { language?: string }).language ?? language };
      const key = `${point}\u0000${JSON.stringify(input)}`;
      let pending = memo.get(key) as Promise<Array<CheckoutAppFunctionResult<P>>> | undefined;
      if (!pending) {
        const forPoint = registrations.filter((registration) => registration.name === point);
        const names = new Map(forPoint.map((registration) => [registration.installation.pluginId, registration.installation.manifest.name]));
        // An app the store approved as blocking here: no answer at all must stop checkout too.
        const blocking = forPoint.some((registration) => registration.installation.grant?.blockingFunctions.some((blockingPoint) => blockingPoint === point)
          && registration.installation.manifest.functions.some((fn) => fn.point === point && fn.onError === "block"));
        pending = sharedHost()
          .then((shared) => runPluginFunctions(point, input, options.env, ctx, { db: options.db, registered: forPoint, host: shared, reads, roles, sandboxRuns, defaultLocale, deadline: requestDeadline(), ...(options.countRefusals ? { countRefusals: true } : {}) }))
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
