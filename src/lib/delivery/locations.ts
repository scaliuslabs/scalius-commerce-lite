import { db } from "@/db";
import { deliveryLocations } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Get the external ID for a location from a specific provider
 * @param locationId - The internal location ID
 * @param providerType - The provider type (e.g. "pathao", "steadfast")
 * @returns The external ID for the provider, or undefined if not found
 */
export async function getExternalLocationId(
  locationId: string,
  providerType: string,
): Promise<string | number | undefined> {
  if (!locationId || !providerType) {
    return undefined;
  }

  try {
    // Get the location from the database
    const [location] = await db
      .select()
      .from(deliveryLocations)
      .where(eq(deliveryLocations.id, locationId));

    if (!location) {
      console.warn(`Location not found for ID: ${locationId}`);
      return undefined;
    }

    // Parse the external IDs
    try {
      const externalIds = JSON.parse(location.externalIds || "{}");
      const externalId = externalIds[providerType];

      if (externalId) {
        // For numeric IDs, convert to number
        if (!isNaN(Number(externalId))) {
          return Number(externalId);
        }
        return externalId;
      }

      console.warn(
        `No external ID found for location ${locationId} with provider ${providerType}`,
      );
      return undefined;
    } catch (error) {
      console.error(
        `Error parsing external IDs for location ${locationId}:`,
        error,
      );
      return undefined;
    }
  } catch (error) {
    console.error(
      `Error getting external ID for location ${locationId}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Get all external IDs for a set of locations
 * @param locations - Object with city, zone, and area IDs
 * @param providerType - The provider type
 * @returns Object with the external IDs
 */
export async function getExternalLocationIds(
  locations: {
    city?: string;
    zone?: string;
    area?: string | null;
  },
  providerType: string,
): Promise<{
  city?: string | number;
  zone?: string | number;
  area?: string | number | null;
}> {
  const result: {
    city?: string | number;
    zone?: string | number;
    area?: string | number | null;
  } = {};

  if (locations.city) {
    result.city = await getExternalLocationId(locations.city, providerType);
  }

  if (locations.zone) {
    result.zone = await getExternalLocationId(locations.zone, providerType);
  }

  if (locations.area) {
    result.area = await getExternalLocationId(locations.area, providerType);
  }

  return result;
}
