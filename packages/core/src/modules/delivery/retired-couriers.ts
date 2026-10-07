// The delivery rows and shipments of the retired built-in couriers (Pathao,
// Steadfast), for the handoff to the app that replaced them
// (apps/api/src/plugins/provider-handoff.ts, docs/platform/PLUGINS.md
// "Retired built-in providers"). Read strictly; rewritten only while each
// row is still the row that was read. Nothing here logs or returns more than
// field names: the values go straight into the app's sealed settings.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { deliveryProviders, deliveryShipments } from "@scalius/database/schema";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { RETIRED_COURIER_PROVIDERS } from "../../integrations/retired-providers";

export interface RetiredCourierRow {
  id: string;
  /** The retired id (`pathao`). */
  type: string;
  isActive: boolean;
  updatedAt: number;
  /** The row's old fields by name (`credentials.<field>` and `config.<field>` merged); empty values left out. */
  values: Record<string, string | number>;
  /** The old fields whose stored credentials could not be opened or parsed. */
  unreadable: string[];
  /** The stored columns as read: the rewrite applies only while they are unchanged. */
  storedCredentials: string;
  storedConfig: string;
}

function objectOf(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function usable(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Every delivery row of a retired courier, its saved fields decrypted with the strict reader. */
export async function readRetiredCourierRows(db: Database, encryptionKey: string): Promise<RetiredCourierRow[]> {
  const types = Object.keys(RETIRED_COURIER_PROVIDERS);
  const rows = await db.select().from(deliveryProviders).where(inArray(deliveryProviders.type, types));
  const retired: RetiredCourierRow[] = [];
  for (const row of rows) {
    const courier = RETIRED_COURIER_PROVIDERS[row.type]!;
    const values: Record<string, string | number> = {};
    const unreadable: string[] = [];
    const read = await readStoredCredentialStrict(row.credentials, encryptionKey, "Delivery provider credentials");
    const credentials = read.error ? null : objectOf(read.value || "{}");
    if (!credentials) unreadable.push(...Object.keys(courier.credentials));
    for (const field of Object.keys(courier.credentials)) {
      const value = credentials ? usable(credentials[field]) : null;
      if (value !== null) values[field] = value;
    }
    const config = objectOf(row.config || "{}") ?? {};
    for (const field of Object.keys(courier.config)) {
      const value = usable(config[field]);
      if (value !== null) values[field] = value;
    }
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt ?? 0);
    retired.push({
      id: row.id,
      type: row.type,
      isActive: row.isActive,
      updatedAt,
      values,
      unreadable,
      storedCredentials: row.credentials,
      storedConfig: row.config,
    });
  }
  return retired;
}

/**
 * Rewrites one retired row as a row of the app courier (name, status and
 * test history kept; the credentials and options, now in the app's
 * settings, dropped), only while it is still the row that was read.
 */
export async function repointRetiredCourierRow(db: Database, row: RetiredCourierRow): Promise<boolean> {
  const replacement = RETIRED_COURIER_PROVIDERS[row.type]!.replacement;
  const updated = await db.update(deliveryProviders)
    .set({ type: replacement, credentials: "{}", config: "{}", updatedAt: sql`unixepoch()` })
    .where(and(
      eq(deliveryProviders.id, row.id),
      eq(deliveryProviders.type, row.type),
      eq(deliveryProviders.credentials, row.storedCredentials),
      eq(deliveryProviders.config, row.storedConfig),
    ))
    .returning({ id: deliveryProviders.id });
  return updated.length > 0;
}

/**
 * Repoints every shipment of a retired courier at the app courier, keeping
 * its public tracking page: a shipment booked before the move saved none (it
 * was derived from the type), so it is saved now. One statement per courier;
 * a second run changes nothing.
 */
export async function repointRetiredCourierShipments(db: Database, retiredType: string): Promise<void> {
  const courier = RETIRED_COURIER_PROVIDERS[retiredType];
  if (!courier) return;
  const [prefix, suffix = ""] = courier.trackingUrl.split("{trackingId}");
  // Couriers' tracking codes are letters and digits; an id that would need
  // escaping keeps no derived page rather than a wrong one.
  const plainId = sql`${deliveryShipments.trackingId} NOT LIKE '%&%' AND ${deliveryShipments.trackingId} NOT LIKE '%#%'
    AND ${deliveryShipments.trackingId} NOT LIKE '%?%' AND ${deliveryShipments.trackingId} NOT LIKE '%/%'
    AND ${deliveryShipments.trackingId} NOT LIKE '% %' AND ${deliveryShipments.trackingId} NOT LIKE '%\\%%' ESCAPE '\\'`;
  await db.update(deliveryShipments)
    .set({
      providerType: courier.replacement,
      courierName: sql`COALESCE(${deliveryShipments.courierName}, ${courier.label})`,
      trackingUrl: sql`CASE WHEN ${deliveryShipments.trackingUrl} IS NULL AND ${deliveryShipments.trackingId} IS NOT NULL AND ${deliveryShipments.trackingId} <> '' AND ${plainId}
        THEN ${prefix} || ${deliveryShipments.trackingId} || ${suffix} ELSE ${deliveryShipments.trackingUrl} END`,
    })
    .where(eq(deliveryShipments.providerType, retiredType));
}
