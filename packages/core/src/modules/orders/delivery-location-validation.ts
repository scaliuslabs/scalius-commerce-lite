import type { Database } from "@scalius/database/client";
import { deliveryLocations } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { and, eq, inArray, isNull } from "drizzle-orm";

export interface DeliveryLocationSelectionInput {
    city: string;
    zone: string;
    area?: string | null;
}

export interface ResolvedDeliveryLocationNames {
    cityName: string;
    zoneName: string;
    areaName: string | null;
}

export interface ActiveDeliveryLocationRow {
    id: string;
    name: string;
    type: "city" | "zone" | "area";
    parentId: string | null;
    isActive: boolean;
    deletedAt: Date | number | null;
}

function deliveryLocationIds(data: DeliveryLocationSelectionInput): string[] {
    return [data.city, data.zone, data.area].filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
}

export function selectActiveDeliveryLocationRows(db: Database, data: DeliveryLocationSelectionInput) {
    const locationIds = deliveryLocationIds(data);
    const query = db
        .select({
            id: deliveryLocations.id,
            name: deliveryLocations.name,
            type: deliveryLocations.type,
            parentId: deliveryLocations.parentId,
            isActive: deliveryLocations.isActive,
            deletedAt: deliveryLocations.deletedAt,
        })
        .from(deliveryLocations);

    if (locationIds.length === 0) {
        return query.limit(0);
    }

    return query.where(
        and(
            inArray(deliveryLocations.id, locationIds),
            eq(deliveryLocations.isActive, true),
            isNull(deliveryLocations.deletedAt),
        ),
    );
}

export function resolveActiveDeliveryLocationNamesFromRows(
    data: DeliveryLocationSelectionInput,
    rows: ActiveDeliveryLocationRow[],
): ResolvedDeliveryLocationNames {
    const locationMap = new Map(rows.map((location) => [location.id, location]));
    const city = locationMap.get(data.city);
    if (!city || city.type !== "city" || city.parentId !== null || city.isActive !== true || city.deletedAt != null) {
        throw new ValidationError("Selected city is no longer available for checkout.");
    }

    const zone = locationMap.get(data.zone);
    if (!zone || zone.type !== "zone" || zone.parentId !== city.id || zone.isActive !== true || zone.deletedAt != null) {
        throw new ValidationError("Selected zone is no longer available for the chosen city.");
    }

    const area = data.area ? locationMap.get(data.area) : null;
    if (data.area && (!area || area.type !== "area" || area.parentId !== zone.id || area.isActive !== true || area.deletedAt != null)) {
        throw new ValidationError("Selected area is no longer available for the chosen zone.");
    }

    return {
        cityName: city.name,
        zoneName: zone.name,
        areaName: area?.name ?? null,
    };
}

export async function resolveActiveDeliveryLocationNames(
    db: Database,
    data: DeliveryLocationSelectionInput,
): Promise<ResolvedDeliveryLocationNames> {
    const rows = await selectActiveDeliveryLocationRows(db, data);
    return resolveActiveDeliveryLocationNamesFromRows(data, Array.isArray(rows) ? rows as ActiveDeliveryLocationRow[] : []);
}
