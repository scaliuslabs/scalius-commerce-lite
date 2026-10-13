// The couriers a request can use. Every courier is an app's
// (`<plugin id>:<provider id>`); they join per request through
// `createCourierProviders(apps)`, built by the API from the active
// installations. Nothing here or in delivery.service.ts branches on a courier.

import { ValidationError } from "@scalius/core/errors";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
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

export function createCourierProviders(apps: readonly Courier[] = []): CourierProviders {
  const byId = new Map<string, Courier>();
  for (const courier of apps) {
    // Only app ids: a courier can never answer for another's id.
    if (!byId.has(courier.id) && isQualifiedProviderId(courier.id)) byId.set(courier.id, courier);
  }
  const get = (id: string | null | undefined): Courier | undefined => (id ? byId.get(id) : undefined);
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
 * only when the id names an app courier, so other work
 * reads no plugin table. Absent: no app couriers.
 */
export type CourierProvidersSource = CourierProviders | (() => Promise<CourierProviders>);

/** The couriers that can answer for `type` from a source. */
export async function courierProvidersFor(
  source: CourierProvidersSource | undefined,
  type: string | null | undefined,
): Promise<CourierProviders> {
  if (!source) return NO_APP_COURIER_PROVIDERS;
  if (typeof source !== "function") return source;
  return isQualifiedProviderId(type) ? source() : NO_APP_COURIER_PROVIDERS;
}

/** The courier a delivery provider row names, if this request can use it. */
export async function courierFor(
  source: CourierProvidersSource | undefined,
  type: string | null | undefined,
): Promise<Courier | undefined> {
  return (await courierProvidersFor(source, type)).get(type);
}
