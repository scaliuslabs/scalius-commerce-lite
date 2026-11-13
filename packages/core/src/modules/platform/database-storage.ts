// The D1 database's size against the plan's cap. D1 refuses writes once a
// database reaches it (planLimits().d1DatabaseBytes), and checkout is a write,
// so Home and the readiness probe report the size well before then. Turso and
// PostgreSQL bill and cap storage by their own plans: no reading there.
import { planLimits } from "@scalius/shared/plan-limits";

export type DatabaseStorageState = "ok" | "warning" | "critical";

export interface DatabaseStorage {
  usedBytes: number;
  capBytes: number;
  state: DatabaseStorageState;
}

/** Warn at 70% of the cap (room to export, prune or move); critical from 90%. */
export const DATABASE_STORAGE_WARNING_RATIO = 0.7;
export const DATABASE_STORAGE_CRITICAL_RATIO = 0.9;

export function databaseStorage(usedBytes: number, capBytes = planLimits().d1DatabaseBytes): DatabaseStorage {
  const ratio = usedBytes / capBytes;
  return {
    usedBytes,
    capBytes,
    state: ratio >= DATABASE_STORAGE_CRITICAL_RATIO ? "critical" : ratio >= DATABASE_STORAGE_WARNING_RATIO ? "warning" : "ok",
  };
}

/** The size a D1 result reports (`meta.size_after`, the database after the statement), or null when it reports none. */
export function d1ResultStorage(result: { meta?: unknown } | null | undefined): DatabaseStorage | null {
  const size = result?.meta && typeof result.meta === "object" ? Reflect.get(result.meta, "size_after") : undefined;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? databaseStorage(size) : null;
}

/** One statement: D1 reports the database's size with every result. */
export async function readD1DatabaseStorage(binding: Pick<D1Database, "prepare">): Promise<DatabaseStorage | null> {
  return d1ResultStorage(await binding.prepare("SELECT 1").run());
}
