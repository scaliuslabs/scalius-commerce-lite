import type { Database } from "@scalius/database/client";

/**
 * The maintenance sweep that aborts multipart upload sessions older than 24 h
 * and deletes replaced objects nothing references (design §3.1, §3.5).
 * Stub until B3 fills it: no I/O, nothing aborted.
 */
export async function sweepDigitalUploads(
  _db: Database,
  _bucket: R2Bucket | undefined,
  _options?: { now?: number },
): Promise<{ aborted: number }> {
  return { aborted: 0 };
}
