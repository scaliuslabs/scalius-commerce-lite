// The Worker entry's check for the storefront incident endpoint
// (storefront-incidents.ts), kept apart so the entry loads only the path.
import { STOREFRONT_INCIDENTS_PATH } from "@scalius/shared/plugins/storefront-incidents";

/** Whether a request is the incident endpoint (exact method and path). */
export function isStorefrontIncidentEndpoint(method: string, pathname: string): boolean {
  return method === "POST" && pathname === STOREFRONT_INCIDENTS_PATH;
}
