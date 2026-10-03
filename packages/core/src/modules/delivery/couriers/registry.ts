// The couriers a request can use. Built-in couriers are one adapter file in
// this directory plus one entry in BUILT_IN_COURIERS; app couriers
// (`<plugin id>:<provider id>`) join per request through
// `createCourierProviders(apps)`, built by the API from the active
// installations. Both implement the same port, so nothing here or in
// delivery.service.ts branches on which kind a courier is.

import { ValidationError } from "@scalius/core/errors";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { pathaoCourier } from "./pathao";
import type { Courier } from "./port";
import { steadfastCourier } from "./steadfast";

const BUILT_IN_COURIERS: readonly Courier[] = [pathaoCourier, steadfastCourier];

/**
 * The couriers of one request, keyed by id (a delivery provider row's
 * `type`). Built per request, never module state: an app courier closes over
 * its installation and the request's plugin host.
 */
export interface CourierProviders {
  /** Built-in couriers first, then app couriers. */
  readonly couriers: readonly Courier[];
  get(id: string | null | undefined): Courier | undefined;
  require(id: string | null | undefined): Courier;
}

export function createCourierProviders(apps: readonly Courier[] = []): CourierProviders {
  const byId = new Map<string, Courier>();
  for (const courier of [...BUILT_IN_COURIERS, ...apps]) {
    // An app cannot shadow a built-in courier: app ids are always qualified.
    if (!byId.has(courier.id) && (BUILT_IN_COURIERS.includes(courier) || isQualifiedProviderId(courier.id))) {
      byId.set(courier.id, courier);
    }
  }
  const get = (id: string | null | undefined) => (id ? byId.get(id) : undefined);
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

/** The built-in couriers alone: for code that never meets an app courier (and tests). */
export const BUILT_IN_COURIER_PROVIDERS: CourierProviders = createCourierProviders();

/**
 * Couriers for work that learns the courier from a row (booking, tracking,
 * recovery, tests, readiness): the request's couriers, or a loader called
 * only when the id names an app courier, so work on built-in couriers reads
 * no plugin table. Absent: built-in couriers alone.
 */
export type CourierProvidersSource = CourierProviders | (() => Promise<CourierProviders>);

/** The couriers that can answer for `type` from a source. */
export async function courierProvidersFor(
  source: CourierProvidersSource | undefined,
  type: string | null | undefined,
): Promise<CourierProviders> {
  if (!source) return BUILT_IN_COURIER_PROVIDERS;
  if (typeof source !== "function") return source;
  return type && isQualifiedProviderId(type) ? source() : BUILT_IN_COURIER_PROVIDERS;
}

/** The courier a delivery provider row names, if this request can use it. */
export async function courierFor(
  source: CourierProvidersSource | undefined,
  type: string | null | undefined,
): Promise<Courier | undefined> {
  return (await courierProvidersFor(source, type)).get(type);
}
