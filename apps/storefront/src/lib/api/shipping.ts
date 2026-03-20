// src/lib/api/shipping.ts

import { getConfiguredSdkClient } from "./client";
import type { LocationData, ShippingMethod } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData } from "./unwrap";
import {
  getApiV1LocationsCities,
  getApiV1LocationsZones,
  getApiV1LocationsAreas,
  getApiV1ShippingMethods,
} from "@scalius/api-client/sdk";

/**
 * Fetches a list of all active cities for shipping.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @returns A promise resolving to an array of city LocationData objects or null on failure.
 */
export async function getCities(): Promise<LocationData[] | null> {
  return withEdgeCache(
    "global_shipping_cities",
    async () => {
      try {
        const { data } = await getApiV1LocationsCities({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<LocationData[]>(data);
      } catch (error: unknown) {
        console.error("Error fetching cities:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a list of all active zones for a given city.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @param cityId The ID of the parent city.
 * @returns A promise resolving to an array of zone LocationData objects or null on failure.
 */
export async function getZones(cityId: string): Promise<LocationData[] | null> {
  if (!cityId) {
    console.error("getZones: cityId is required.");
    return null;
  }

  return withEdgeCache(
    `shipping_zones_${cityId}`,
    async () => {
      try {
        const { data } = await getApiV1LocationsZones({
          client: getConfiguredSdkClient(),
          query: { cityId },
        });
        return unwrapData<LocationData[]>(data);
      } catch (error: unknown) {
        console.error(`Error fetching zones for city "${cityId}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a list of all active areas for a given zone.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @param zoneId The ID of the parent zone.
 * @returns A promise resolving to an array of area LocationData objects or null on failure.
 */
export async function getAreas(zoneId: string): Promise<LocationData[] | null> {
  if (!zoneId) {
    console.error("getAreas: zoneId is required.");
    return null;
  }

  return withEdgeCache(
    `shipping_areas_${zoneId}`,
    async () => {
      try {
        const { data } = await getApiV1LocationsAreas({
          client: getConfiguredSdkClient(),
          query: { zoneId },
        });
        return unwrapData<LocationData[]>(data);
      } catch (error: unknown) {
        console.error(`Error fetching areas for zone "${zoneId}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches all active shipping methods available for the store.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @returns A promise resolving to an array of ShippingMethod objects or null on failure.
 */
export async function getShippingMethods(): Promise<ShippingMethod[] | null> {
  return withEdgeCache(
    "global_shipping_methods",
    async () => {
      try {
        const { data } = await getApiV1ShippingMethods({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<{ shippingMethods: ShippingMethod[] }>(data)?.shippingMethods ?? null;
      } catch (error: unknown) {
        console.error("Error fetching shipping methods:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
