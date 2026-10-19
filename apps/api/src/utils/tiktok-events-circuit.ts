// The TikTok Events API browser-event circuit, the same rule as Meta's
// (meta-capi-circuit.ts): a non-retryable provider or config failure opens it
// for 15 minutes, while open browser events skip TikTok, and a tracking
// settings save closes it. The `system_kv` row is the authority; a 60-second
// per-colo Cache API hint keeps the hot path off the database.
import type { Database } from "@scalius/database/client";
import { deleteSystemKv, getSystemKv, putSystemKv } from "@scalius/core/utils/system-kv";
import { workerCacheHint } from "@scalius/shared/worker-cache-hint";

export const TIKTOK_BROWSER_CIRCUIT_KEY = "tiktok-events:browser-events:circuit";
export const TIKTOK_BROWSER_CIRCUIT_TTL_SECONDS = 15 * 60;

type CircuitEnv = Parameters<typeof workerCacheHint>[0];

const hint = (env: CircuitEnv) => workerCacheHint(env, "tiktok-events-circuit", 60);

function warn(action: string, error: unknown): void {
  console.warn(`[TikTok Events API] Browser event circuit could not be ${action}`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Whether TikTok browser events skip dispatch now. A failed read fails open. */
export async function isTikTokBrowserCircuitOpen(db: Database, env: CircuitEnv, now = Date.now()): Promise<boolean> {
  try {
    const cache = hint(env);
    const cached = await cache?.get(TIKTOK_BROWSER_CIRCUIT_KEY).catch(() => null);
    if (cached != null) return Number(cached) > now;
    const raw = await getSystemKv(db, TIKTOK_BROWSER_CIRCUIT_KEY);
    const openUntil = raw ? Number((JSON.parse(raw) as { openUntil?: unknown }).openUntil) || 0 : 0;
    await cache?.put(TIKTOK_BROWSER_CIRCUIT_KEY, String(openUntil)).catch(() => undefined);
    return openUntil > now;
  } catch (error) {
    warn("read", error);
    return false;
  }
}

export async function openTikTokBrowserCircuit(db: Database, env: CircuitEnv, reason: string, now = Date.now()): Promise<void> {
  const openUntil = now + TIKTOK_BROWSER_CIRCUIT_TTL_SECONDS * 1000;
  try {
    await putSystemKv(db, TIKTOK_BROWSER_CIRCUIT_KEY, JSON.stringify({ reason, openedAt: now, openUntil }), Math.ceil(openUntil / 1000));
    await hint(env)?.put(TIKTOK_BROWSER_CIRCUIT_KEY, String(openUntil)).catch(() => undefined);
  } catch (error) {
    warn("opened", error);
  }
}

export async function clearTikTokBrowserCircuit(db: Database, env: CircuitEnv): Promise<void> {
  try {
    await deleteSystemKv(db, TIKTOK_BROWSER_CIRCUIT_KEY);
    await hint(env)?.delete(TIKTOK_BROWSER_CIRCUIT_KEY).catch(() => undefined);
  } catch (error) {
    warn("cleared", error);
  }
}
