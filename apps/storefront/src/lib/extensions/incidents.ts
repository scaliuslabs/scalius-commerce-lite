// Tells the API that the store drew a page without an app's part
// (`@scalius/shared/plugins/storefront-incidents`): the app's log then names
// the part and why, so a skin or section that falls back is never silent.
// The report runs after the response (`waitUntil`), carries the frontier key
// (HKDF of SCALIUS_SECRET) and never the page, the buyer or the data drawn.
// Any failure is dropped: an incident must never cost a page.

import { CACHE_FRONTIER_KEY_HEADER, CACHE_FRONTIER_SECRET_PURPOSE } from "@scalius/shared/cache-frontier";
import { deriveRuntimeSecret, readMasterSecret, type MasterSecretEnvironment } from "@scalius/shared/runtime-secrets";
import { STOREFRONT_INCIDENTS_PATH, type StorefrontIncident } from "@scalius/shared/plugins/storefront-incidents";
import { backendFetch } from "./backend";

const REPORT_TIMEOUT_MS = 3_000;

export async function sendStorefrontIncident(
  env: MasterSecretEnvironment & { BACKEND_API?: Fetcher },
  incident: StorefrontIncident,
): Promise<void> {
  const master = readMasterSecret(env);
  if (!master) return;
  const response = await backendFetch(env, STOREFRONT_INCIDENTS_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [CACHE_FRONTIER_KEY_HEADER]: await deriveRuntimeSecret(master, CACHE_FRONTIER_SECRET_PURPOSE),
    },
    body: JSON.stringify({ incidents: [incident] }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  await response?.body?.cancel();
}

/** A reporter for one request: each incident is sent after the response. */
export function storefrontIncidentReporter(
  env: MasterSecretEnvironment & { BACKEND_API?: Fetcher },
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): (incident: StorefrontIncident) => void {
  return (incident) => {
    const task = sendStorefrontIncident(env, incident).catch(() => undefined);
    waitUntil?.(task);
  };
}
