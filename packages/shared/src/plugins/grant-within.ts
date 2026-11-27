// An app runs within the grant a person approved (packages/plugin-sdk/docs/apps.md,
// "Updates"). An update replaces the code at once; what its manifest asks
// for beyond the approved grant waits for approval while everything already
// approved keeps running. So the host never reads the manifest's request as
// permission: the manifest an installation runs is the declared one, with its
// on features, narrowed to the grant (`pluginManifestWithinGrant`), and a
// grant only ever narrows without a person (`pluginGrantWithin`).

import { eventFilterCovered, pluginGrantAdditions, pluginMessageRecipientKey, PLUGIN_GRANT_FLAG_DIMENSIONS, PLUGIN_GRANT_LIST_DIMENSIONS, type PluginGrantRequest, type PluginManifest } from "./manifest";
import type { EventTopicFilter } from "../events";

const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** Whether two topic filters share a topic (`order.*` and `order.paid` do). */
function eventFiltersOverlap(filter: EventTopicFilter, granted: readonly EventTopicFilter[]): boolean {
  return eventFilterCovered(filter, granted) || granted.some((each) => eventFilterCovered(each, [filter]));
}

/**
 * What of `granted` the app still asks for in `request`: each dimension the
 * intersection, so a grant only narrows. Event filters keep the request's
 * filters the grant covers and the granted filters the request covers (an
 * update that widens `order.paid` to `order.*` keeps `order.paid`).
 */
export function pluginGrantWithin(granted: PluginGrantRequest, request: PluginGrantRequest): PluginGrantRequest {
  const within: Record<string, unknown> = {};
  for (const dimension of PLUGIN_GRANT_LIST_DIMENSIONS) {
    const before = granted[dimension] as readonly string[];
    const after = request[dimension] as readonly string[];
    within[dimension] = dimension === "events"
      ? sorted([
        ...request.events.filter((filter) => eventFilterCovered(filter, granted.events)),
        ...granted.events.filter((filter) => eventFilterCovered(filter, request.events)),
      ])
      : sorted(after.filter((value) => before.includes(value)));
  }
  for (const dimension of PLUGIN_GRANT_FLAG_DIMENSIONS) within[dimension] = granted[dimension] && request[dimension];
  return within as unknown as PluginGrantRequest;
}

/**
 * The grant after a person approves the step from `before` to `after` (a
 * feature turned on): what was granted and is still asked, plus what the
 * step itself adds. Anything `before` asked that was never approved (an
 * update's new permissions, a blocking the store turned off) stays out:
 * approving one thing never approves another that was not shown.
 */
export function pluginGrantApproving(granted: PluginGrantRequest, before: PluginGrantRequest, after: PluginGrantRequest): PluginGrantRequest {
  const kept = pluginGrantWithin(granted, after);
  const step = pluginGrantAdditions(before, after);
  const approved: Record<string, unknown> = {};
  for (const dimension of PLUGIN_GRANT_LIST_DIMENSIONS) {
    approved[dimension] = sorted([...(kept[dimension] as readonly string[]), ...(step[dimension] as readonly string[])]);
  }
  for (const dimension of PLUGIN_GRANT_FLAG_DIMENSIONS) approved[dimension] = kept[dimension] || step[dimension];
  return approved as unknown as PluginGrantRequest;
}

/**
 * The manifest as it may run under `grant`: every capability the grant does
 * not cover is left out, exactly as if the app never asked for it. The
 * request of the result (`pluginGrantRequest`) asks for nothing beyond the
 * grant, except that an event filter overlapping a granted one stays (its
 * handler keeps its name) and each delivery is checked per topic against
 * the grant (`event-deliveries.ts`, `event-delivery.ts`).
 *
 * - scopes, outbound hosts, providers by port, function points, buyer UI
 *   slots, custom-field owners, script and island hosts, message recipients:
 *   only the granted ones (a feature's own scopes and hosts too);
 * - a function the grant does not approve as blocking runs with `onError: "skip"`;
 * - no `publicRoutes`: no public or webhook routes, no storefront proxy;
 * - no `storefrontSurfaces`: no sections, components, skins or head tags;
 * - no `storefrontCode`: no storefront module, islands or stylesheet;
 * - no `storefrontPixel`: no pixel; no `storefrontBuyerPages`: no skin on the buyer's pages;
 * - no `buyerFiles`: no checkout attribute or line input of type `file`.
 *
 * Settings, objects, jobs, cron, admin surfaces and theme templates are not
 * grant dimensions: what they reach goes through the scopes above.
 */
export function pluginManifestWithinGrant(manifest: PluginManifest, grant: PluginGrantRequest): PluginManifest {
  const scopes = new Set<string>(grant.scopes);
  const hosts = new Set(grant.allowedHosts);
  const functions = new Set<string>(grant.functions);
  const blocking = new Set<string>(grant.blockingFunctions);
  const slots = new Set<string>(grant.extensions);
  const providers = new Set<string>(grant.providers);
  const owners = new Set(grant.customFieldOwners);
  const scripts = new Set(grant.storefrontScripts);
  const connect = new Set(grant.storefrontConnect);
  const recipients = new Set(grant.messageRecipients);
  const storefront = manifest.storefront;
  const surfaces = grant.storefrontSurfaces && grant.storefrontCode;
  const scriptHost = (src: string) => {
    try {
      return new URL(src).host;
    } catch {
      return null;
    }
  };
  const notFile = <T extends { type?: string }>(field: T) => grant.buyerFiles || field.type !== "file";
  const { pixel, ...storefrontRest } = storefront;
  return {
    ...manifest,
    scopes: manifest.scopes.filter((scope) => scopes.has(scope)),
    allowedHosts: manifest.allowedHosts.filter((host) => hosts.has(host)),
    events: manifest.events.filter((filter) => eventFiltersOverlap(filter, grant.events)),
    functions: manifest.functions
      .filter((fn) => functions.has(fn.point))
      .map((fn) => (fn.onError === "block" && !blocking.has(fn.point) ? { ...fn, onError: "skip" as const } : fn)),
    providers: manifest.providers.filter((provider) => providers.has(provider.kind)),
    customFields: manifest.customFields.filter((field) => owners.has(field.ownerType)),
    routes: grant.publicRoutes ? manifest.routes : { ...manifest.routes, public: [], webhooks: [] },
    messaging: { ...manifest.messaging, recipients: manifest.messaging.recipients.filter((recipient) => recipients.has(pluginMessageRecipientKey(recipient))) },
    ...(manifest.checkout
      ? { checkout: { ...manifest.checkout, attributes: manifest.checkout.attributes.filter(notFile), lineInputs: manifest.checkout.lineInputs.filter(notFile) } }
      : {}),
    features: manifest.features.map((feature) => ({
      ...feature,
      scopes: feature.scopes.filter((scope) => scopes.has(scope)),
      allowedHosts: feature.allowedHosts.filter((host) => hosts.has(host)),
    })),
    storefront: {
      ...storefrontRest,
      ...(pixel && grant.storefrontPixel ? { pixel } : {}),
      proxy: grant.publicRoutes && storefront.proxy,
      head: grant.storefrontSurfaces && storefront.head,
      scripts: storefront.scripts.filter((script) => {
        const host = scriptHost(script.src);
        return host !== null && scripts.has(host);
      }),
      extensions: storefront.extensions.filter((extension) => slots.has(extension.target)),
      sections: surfaces ? storefront.sections : [],
      components: surfaces ? storefront.components : [],
      skins: surfaces
        ? storefront.skins.map((skin) => {
          if (skin.buyerPages !== true || grant.storefrontBuyerPages) return skin;
          const { buyerPages: _ungranted, ...rest } = skin;
          return rest;
        })
        : [],
      islands: grant.storefrontCode ? storefront.islands : [],
      stylesheet: grant.storefrontCode ? storefront.stylesheet : false,
      connect: storefront.connect.filter((host) => connect.has(host)),
    },
  };
}
