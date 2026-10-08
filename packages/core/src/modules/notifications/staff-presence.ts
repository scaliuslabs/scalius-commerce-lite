// Which staff have an open dashboard, per the store's realtime hub
// (apps/api/src/realtime/hub.ts, docs/platform/REALTIME.md). Web Push
// complements the hub: a staff member the hub reaches live gets no push for
// the same fact. One Durable Object RPC, no database read. Unknown (no
// binding, a hub error) means nobody counts as online, so push still goes out.
import { REALTIME_HUB_NAME } from "@scalius/shared/realtime";

interface HubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { online(): Promise<string[]> };
}

function isHubNamespace(value: unknown): value is HubNamespace {
  return typeof value === "object" && value !== null
    && typeof (value as { idFromName?: unknown }).idFromName === "function"
    && typeof (value as { get?: unknown }).get === "function";
}

export async function onlineStaffIds(env: object | undefined): Promise<ReadonlySet<string>> {
  const namespace = (env as { REALTIME_HUB?: unknown } | undefined)?.REALTIME_HUB;
  if (!isHubNamespace(namespace)) return new Set();
  try {
    const ids = await namespace.get(namespace.idFromName(REALTIME_HUB_NAME)).online();
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}
