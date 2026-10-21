// Which `bulk_runs` rows are one app's background jobs (`ctx.jobs`,
// apps/api/src/plugins/jobs.ts). Every app job's operation key starts with
// `app:<plugin id>:<job name>:`, so an app's jobs (or one job's) are a range
// of the operation-key unique index: listing, counting the running ones and
// deleting them on uninstall read that range, never a scan. Plugin ids and
// job names hold no `:`, and `;` sorts right after it, so the range ends at
// the same prefix with `;`.
import { and, eq, gte, lt, type SQL } from "drizzle-orm";
import { APP_JOB_RUN_KIND, bulkRuns } from "@scalius/database/schema";

/** The operation-key prefix of an app's jobs, or of one of its jobs. */
export function appJobKeyPrefix(pluginId: string, job?: string): string {
  return job === undefined ? `app:${pluginId}:` : `app:${pluginId}:${job}:`;
}

/** The app's job rows (of one job when `job` is given). */
export function appJobRowsCondition(pluginId: string, job?: string): SQL {
  const prefix = appJobKeyPrefix(pluginId, job);
  return and(
    eq(bulkRuns.kind, APP_JOB_RUN_KIND),
    gte(bulkRuns.operationKey, prefix),
    lt(bulkRuns.operationKey, `${prefix.slice(0, -1)};`),
  )!;
}
