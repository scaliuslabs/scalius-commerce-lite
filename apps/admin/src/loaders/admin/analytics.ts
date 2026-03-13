import { db } from "@scalius/database/client";
import { AnalyticsService } from "@scalius/core/modules/analytics/analytics.service";
import { unixToDate } from "@scalius/shared/utils";

export async function getAnalyticsListData() {
  const analyticsScripts = await AnalyticsService.listScripts(db);
  return analyticsScripts.map((script: any) => ({
    id: script.id,
    name: script.name,
    type: script.type,
    isActive: script.isActive,
    usePartytown: script.usePartytown,
    location: script.location,
    createdAt: script.createdAt ? new Date(script.createdAt) : new Date(),
    updatedAt: script.updatedAt ? new Date(script.updatedAt) : new Date(),
  }));
}

export async function getAnalyticsEditData(id: string) {
  const script = await AnalyticsService.getScript(db, id);
  if (!script) return null;

  const validType = ["google_analytics", "facebook_pixel", "custom"].includes(
    script.type,
  )
    ? (script.type as "google_analytics" | "facebook_pixel" | "custom")
    : "custom";

  const validLocation = ["head", "body_start", "body_end"].includes(script.location)
    ? (script.location as "head" | "body_start" | "body_end")
    : "head";

  return {
    id: script.id,
    name: script.name,
    type: validType,
    isActive: script.isActive,
    usePartytown: script.usePartytown ?? true,
    config: script.config,
    location: validLocation,
    createdAt: unixToDate(script.createdAt) || new Date(),
    updatedAt: unixToDate(script.updatedAt) || new Date(),
  };
}
