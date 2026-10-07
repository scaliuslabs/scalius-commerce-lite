// The couriers a request can use. Every courier is an app's
// (`<plugin id>:<provider id>`); they join per request through
// `createCourierProviders(apps)`, built by the API from the active
// installations. Nothing here or in delivery.service.ts branches on a courier.
//
// A row or shipment that still names a retired built-in courier (`pathao`,
// `steadfast`: core/integrations/retired-providers.ts) resolves to the app
// courier that replaced it. While that app is not active, the retired id
// resolves to a courier that fails closed with the app's reason ("Activate
// Bangladesh pack in Apps to use it."): it books, tracks and tests nothing.

import { ValidationError } from "@scalius/core/errors";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { ProviderError } from "@scalius/shared/plugins/providers";
import {
  BANGLADESH_PACK_NAME,
  RETIRED_COURIER_PROVIDERS,
  retiredProviderReplacement,
} from "../../../integrations/retired-providers";
import { getDeliveryProviderReadinessSummary } from "../provider-readiness";
import type { Courier } from "./port";

/**
 * The couriers of one request, keyed by id (a delivery provider row's
 * `type`). Built per request, never module state: an app courier closes over
 * its installation and the request's plugin host.
 */
export interface CourierProviders {
  readonly couriers: readonly Courier[];
  get(id: string | null | undefined): Courier | undefined;
  require(id: string | null | undefined): Courier;
}

/** Why a retired courier cannot be used yet, in the merchant's words. */
export function retiredCourierReason(): string {
  return `Activate ${BANGLADESH_PACK_NAME} in Apps to use it.`;
}

/** A retired built-in courier whose app is not active: readable, never called. */
function inactiveRetiredCourier(id: string): Courier {
  const retired = RETIRED_COURIER_PROVIDERS[id]!;
  const refuse = async (): Promise<never> => {
    throw new ProviderError("misconfigured", `${retired.label}: ${retiredCourierReason()}`, { code: "courier.app_inactive" });
  };
  return {
    id,
    label: retired.label,
    countries: ["BD"],
    async setup(provider) {
      return {
        settings: null,
        error: retiredCourierReason(),
        readiness: getDeliveryProviderReadinessSummary({
          type: provider.type,
          activationBlockers: [{ source: "config", key: "app", label: BANGLADESH_PACK_NAME, message: retiredCourierReason() }],
          isActive: provider.isActive,
          lastTestAttemptAt: provider.lastTestAttemptAt,
          lastTestSuccessAt: provider.lastTestSuccessAt,
          lastTestFailureAt: provider.lastTestFailureAt,
        }),
      };
    },
    createShipment: refuse,
    trackShipment: refuse,
  };
}

export function createCourierProviders(apps: readonly Courier[] = []): CourierProviders {
  const byId = new Map<string, Courier>();
  for (const courier of apps) {
    // Only app ids: a courier can never answer for another's id.
    if (!byId.has(courier.id) && isQualifiedProviderId(courier.id)) byId.set(courier.id, courier);
  }
  const get = (id: string | null | undefined): Courier | undefined => {
    if (!id) return undefined;
    const own = byId.get(id);
    if (own) return own;
    const replacement = retiredProviderReplacement("courier", id);
    if (!replacement) return undefined;
    return byId.get(replacement) ?? inactiveRetiredCourier(id);
  };
  return {
    couriers: [...byId.values()],
    get,
    require(id) {
      const courier = get(id);
      if (!courier) throw new ValidationError(`Unsupported provider type: ${id ?? "none"}`);
      return courier;
    },
  };
}

/** No app couriers: for code that never meets one (and tests). */
export const NO_APP_COURIER_PROVIDERS: CourierProviders = createCourierProviders();

/**
 * Couriers for work that learns the courier from a row (booking, tracking,
 * recovery, tests, readiness): the request's couriers, or a loader called
 * only when the id names an app courier (or a retired one), so other work
 * reads no plugin table. Absent: no app couriers.
 */
export type CourierProvidersSource = CourierProviders | (() => Promise<CourierProviders>);

/** Whether a row type can name an app courier (its own id or a retired built-in id). */
function namesAppCourier(type: string | null | undefined): boolean {
  return isQualifiedProviderId(type) || retiredProviderReplacement("courier", type) !== null;
}

/** The couriers that can answer for `type` from a source. */
export async function courierProvidersFor(
  source: CourierProvidersSource | undefined,
  type: string | null | undefined,
): Promise<CourierProviders> {
  if (!source) return NO_APP_COURIER_PROVIDERS;
  if (typeof source !== "function") return source;
  return namesAppCourier(type) ? source() : NO_APP_COURIER_PROVIDERS;
}

/** The courier a delivery provider row names, if this request can use it. */
export async function courierFor(
  source: CourierProvidersSource | undefined,
  type: string | null | undefined,
): Promise<Courier | undefined> {
  return (await courierProvidersFor(source, type)).get(type);
}
