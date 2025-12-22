import type { APIRoute } from "astro";
import { db } from "@/db";
import { deliveryLocations, deliveryProviders } from "@/db/schema";
import { eq, isNull, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

const PATHAO_API_BASE_URL = "https://api-hermes.pathao.com"; // Production URL

// Function to get Pathao access token
async function getPathaoAccessToken() {
  const provider = await db
    .select()
    .from(deliveryProviders)
    .where(eq(deliveryProviders.type, "pathao"))
    .limit(1)
    .then((res) => res[0]);

  if (!provider || !provider.credentials) {
    throw new Error(
      "Pathao provider credentials not found or incomplete in DB.",
    );
  }

  let creds;
  try {
    creds = JSON.parse(provider.credentials);
  } catch (e) {
    throw new Error("Failed to parse Pathao credentials from DB.");
  }

  const requiredCreds = ["clientId", "clientSecret", "username", "password"];
  for (const key of requiredCreds) {
    if (!creds[key]) {
      throw new Error(`Pathao credential '${key}' is missing.`);
    }
  }

  const response = await fetch(
    `${PATHAO_API_BASE_URL}/aladdin/api/v1/issue-token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        username: creds.username,
        password: creds.password,
        grant_type: "password",
      }),
    },
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error("Pathao token API error response:", errorData);
    throw new Error(
      `Failed to issue Pathao access token: ${response.status} ${response.statusText}. ${errorData.message || ""}`,
    );
  }

  const tokenData = await response.json();
  if (!tokenData.access_token) {
    throw new Error("Access token not found in Pathao's response.");
  }
  return tokenData.access_token;
}

// These functions replace the pathao-cache dependency
async function getPathaoCities(accessToken: string) {
  try {
    const response = await fetch(
      `${PATHAO_API_BASE_URL}/aladdin/api/v1/countries/1/city-list`, // Assuming country ID 1 is still valid for BD
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch cities: ${response.status}`);
    }

    const data = await response.json();
    return data.data.data || [];
  } catch (error) {
    console.error("Error fetching Pathao cities:", error);
    return [];
  }
}

async function getPathaoZones(cityId: number, accessToken: string) {
  try {
    const response = await fetch(
      `${PATHAO_API_BASE_URL}/aladdin/api/v1/cities/${cityId}/zone-list`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch zones: ${response.status}`);
    }

    const data = await response.json();
    return data.data.data || [];
  } catch (error) {
    console.error(`Error fetching zones for city ${cityId}:`, error);
    return [];
  }
}

async function getPathaoAreas(zoneId: number, accessToken: string) {
  try {
    const response = await fetch(
      `${PATHAO_API_BASE_URL}/aladdin/api/v1/zones/${zoneId}/area-list`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch areas: ${response.status}`);
    }

    const data = await response.json();
    return data.data.data || [];
  } catch (error) {
    console.error(`Error fetching areas for zone ${zoneId}:`, error);
    return [];
  }
}

// Batch size for more efficient imports
const BATCH_SIZE = 50;
// Concurrency for API calls to Pathao
const API_CONCURRENCY_LIMIT = 5;

// Function to insert locations in batches
async function batchInsertLocations(locations: any[]) {
  // Process in chunks to avoid overwhelming the database
  for (let i = 0; i < locations.length; i += BATCH_SIZE) {
    const batch = locations.slice(i, i + BATCH_SIZE);

    await db.insert(deliveryLocations).values(batch);
  }
}

export const POST: APIRoute = async () => {
  try {
    // Step 0: Get Access Token
    const accessToken = await getPathaoAccessToken();

    // Step 1: Count existing locations to check if we've already imported
    const existingCount = await db
      .select({ count: sql`count(*)` })
      .from(deliveryLocations)
      .where(isNull(deliveryLocations.deletedAt))
      .then((res) => Number(res[0]?.count || 0));

    if (existingCount > 0) {
      return new Response(
        JSON.stringify({
          message: "Locations already imported",
          count: existingCount,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 2: Import cities
    const cities = await getPathaoCities(accessToken);
    const cityRecords = [];
    const cityMap = new Map(); // To keep track of city IDs for zones

    for (const city of cities) {
      const cityId = createId();
      cityMap.set(city.city_id.toString(), cityId);

      cityRecords.push({
        id: cityId,
        name: city.city_name,
        type: "city",
        parentId: null,
        externalIds: JSON.stringify({
          pathao: city.city_id.toString(),
        }),
        metadata: JSON.stringify({
          original: city,
        }),
        isActive: true,
        sortOrder: 0,
        createdAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      });
    }

    // Insert all cities in a batch
    await batchInsertLocations(cityRecords);

    // Step 3: Import zones for each city (with efficient fetching)
    const zoneRecords = [];
    const zoneMap = new Map(); // To keep track of zone IDs for areas

    // Process cities in batches for concurrent zone fetching
    const cityEntries = Array.from(cityMap.entries());
    for (let i = 0; i < cityEntries.length; i += API_CONCURRENCY_LIMIT) {
      const cityBatch = cityEntries.slice(i, i + API_CONCURRENCY_LIMIT);
      const zonePromises = cityBatch.map(([pathaoCityId, ourCityId]) =>
        getPathaoZones(parseInt(pathaoCityId), accessToken).then(
          (zones) => zones.map((zone: any) => ({ ...zone, ourCityId })), // Attach ourCityId for parent linking
        ),
      );

      const results = await Promise.allSettled(zonePromises);

      for (const result of results) {
        if (result.status === "fulfilled") {
          const zonesWithParent = result.value;
          for (const zone of zonesWithParent) {
            const zoneId = createId();
            zoneMap.set(zone.zone_id.toString(), zoneId);
            zoneRecords.push({
              id: zoneId,
              name: zone.zone_name,
              type: "zone",
              parentId: zone.ourCityId, // Use the attached ourCityId
              externalIds: JSON.stringify({
                pathao: zone.zone_id.toString(),
              }),
              metadata: JSON.stringify({
                original: zone,
              }),
              isActive: true,
              sortOrder: 0,
              createdAt: sql`CURRENT_TIMESTAMP`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            });
          }
        }
      }
      // Insert zones in batches as they are processed
      if (zoneRecords.length >= BATCH_SIZE) {
        await batchInsertLocations(zoneRecords);
        zoneRecords.length = 0; // Clear the array
      }
    }
    // Insert any remaining zones from the last batch
    if (zoneRecords.length > 0) {
      await batchInsertLocations(zoneRecords);
      zoneRecords.length = 0;
    }

    // Step 4: Import areas for each zone (with efficient fetching)
    const areaRecords = [];
    let totalAreas = 0;

    // Process zones in batches for concurrent area fetching
    const zoneEntries = Array.from(zoneMap.entries());
    for (let i = 0; i < zoneEntries.length; i += API_CONCURRENCY_LIMIT) {
      const zoneBatch = zoneEntries.slice(i, i + API_CONCURRENCY_LIMIT);
      const areaPromises = zoneBatch.map(([pathaoZoneId, ourZoneId]) =>
        getPathaoAreas(parseInt(pathaoZoneId), accessToken).then(
          (areas) => areas.map((area: any) => ({ ...area, ourZoneId })), // Attach ourZoneId for parent linking
        ),
      );

      const results = await Promise.allSettled(areaPromises);

      for (const result of results) {
        if (result.status === "fulfilled") {
          const areasWithParent = result.value;
          totalAreas += areasWithParent.length;
          for (const area of areasWithParent) {
            areaRecords.push({
              id: createId(),
              name: area.area_name,
              type: "area",
              parentId: area.ourZoneId, // Use the attached ourZoneId
              externalIds: JSON.stringify({
                pathao: area.area_id.toString(),
              }),
              metadata: JSON.stringify({
                homeDeliveryAvailable: area.home_delivery_available,
                pickupAvailable: area.pickup_available,
                original: area,
              }),
              isActive: true,
              sortOrder: 0,
              createdAt: sql`CURRENT_TIMESTAMP`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            });

            // Insert in batches to avoid memory issues
            if (areaRecords.length >= BATCH_SIZE) {
              await batchInsertLocations(areaRecords);
              areaRecords.length = 0; // Clear the array
            }
          }
        }
      }
    }

    // Insert any remaining areas from the last batch
    if (areaRecords.length > 0) {
      await batchInsertLocations(areaRecords);
      areaRecords.length = 0;
    }

    // Return counts of imported items
    return new Response(
      JSON.stringify({
        success: true,
        message: "Locations imported successfully",
        counts: {
          cities: cityRecords.length,
          zones: zoneRecords.length,
          areas: totalAreas,
          total: cityRecords.length + zoneRecords.length + totalAreas,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error importing Pathao locations:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Failed to import Pathao locations",
        details: error instanceof Error ? error.stack : undefined,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
