// The Meta CAPI browser-event circuit. A non-retryable provider or config
// failure opens it for 15 minutes; while open, browser events skip dispatch;
// a successful Meta settings save closes it. The `system_kv` row is the
// authority; a 60-second per-colo Cache API hint keeps the hot path (every
// browser event) off the database.
import type { Database } from "@scalius/database/client";
import { deleteSystemKv, getSystemKv, putSystemKv } from "@scalius/core/utils/system-kv";
import { workerCacheHint } from "@scalius/shared/worker-cache-hint";

export const META_CAPI_BROWSER_CIRCUIT_KEY = "meta-capi:browser-events:circuit";
export const META_CAPI_BROWSER_CIRCUIT_TTL_SECONDS = 15 * 60;

type CircuitEnv = Parameters<typeof workerCacheHint>[0];

const hint = (env: CircuitEnv) => workerCacheHint(env, "meta-capi-circuit", 60);

function warn(action: string, error: unknown): void {
  console.warn(`[Meta CAPI] Browser event circuit could not be ${action}`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Whether browser events skip dispatch now. A failed read fails open (dispatch), as before. */
export async function isMetaCapiBrowserCircuitOpen(db: Database, env: CircuitEnv, now = Date.now()): Promise<boolean> {
  try {
    const cache = hint(env);
    const cached = await cache?.get(META_CAPI_BROWSER_CIRCUIT_KEY).catch(() => null);
    if (cached != null) return Number(cached) > now;
    const raw = await getSystemKv(db, META_CAPI_BROWSER_CIRCUIT_KEY);
    const openUntil = raw ? Number((JSON.parse(raw) as { openUntil?: unknown }).openUntil) || 0 : 0;
    await cache?.put(META_CAPI_BROWSER_CIRCUIT_KEY, String(openUntil)).catch(() => undefined);
    return openUntil > now;
  } catch (error) {
    warn("read", error);
    return false;
  }
}

export async function openMetaCapiBrowserCircuit(
  db: Database,
  env: CircuitEnv,
  reason: string,
  eventName: string,
  now = Date.now(),
): Promise<void> {
  const openUntil = now + META_CAPI_BROWSER_CIRCUIT_TTL_SECONDS * 1000;
  try {
    await putSystemKv(
      db,
      META_CAPI_BROWSER_CIRCUIT_KEY,
      JSON.stringify({ reason, eventName, openedAt: now, openUntil }),
      Math.ceil(openUntil / 1000),
    );
    await hint(env)?.put(META_CAPI_BROWSER_CIRCUIT_KEY, String(openUntil)).catch(() => undefined);
  } catch (error) {
    warn("opened", error);
  }
}

/** Closes the circuit (the saving colo at once; others within the hint's 60 s). */
export async function clearMetaCapiBrowserCircuit(db: Database, env: CircuitEnv): Promise<void> {
  try {
    await deleteSystemKv(db, META_CAPI_BROWSER_CIRCUIT_KEY);
    await hint(env)?.delete(META_CAPI_BROWSER_CIRCUIT_KEY).catch(() => undefined);
  } catch (error) {
    warn("cleared", error);
  }
}
