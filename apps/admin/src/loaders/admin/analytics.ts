import { apiGet } from "@/lib/api-fetch";

export async function getAnalyticsListData() {
  // API returns ok(c, scripts) where scripts is an array.
  // apiGet calls the API directly (not through the admin proxy) and
  // unwraps { success, data: T } → T. So result IS the array.
  const result = await apiGet<any>("/analytics");
  const scripts = Array.isArray(result) ? result : [];

  return scripts.map((script: any) => ({
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
  // API returns ok(c, script) where script is an object -> proxy unwraps.
  const script = await apiGet<any>("/analytics/" + id).catch(() => null);
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
    createdAt: script.createdAt ? new Date(script.createdAt) : new Date(),
    updatedAt: script.updatedAt ? new Date(script.updatedAt) : new Date(),
  };
}
