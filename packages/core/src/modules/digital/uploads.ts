import type { Database } from "@scalius/database/client";
import { digitalAssets, digitalAssetUploads } from "@scalius/database/schema";
import { DIGITAL_UPLOAD_STALE_SECONDS } from "@scalius/shared/digital";
import { and, asc, eq, lt, sql } from "drizzle-orm";

/** Upload rows one sweep visits per state (bounded work, sequential R2 calls). */
const SWEEP_LIMIT = 25;

/**
 * The maintenance sweep (design §3.1, §3.5): aborts multipart upload sessions
 * older than 24 h, and deletes a replaced file's object a day after the asset
 * moved to a newer upload (download tickets live 10 minutes, so no stream
 * still reads it). Failures are per row and retried by the next run.
 */
export async function sweepDigitalUploads(
    db: Database,
    bucket: R2Bucket | undefined,
    options: { now?: number } = {},
): Promise<{ aborted: number }> {
    if (!bucket) return { aborted: 0 };
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const cutoff = now - DIGITAL_UPLOAD_STALE_SECONDS;
    let aborted = 0;

    // Driven by the partial index on uploading sessions.
    const stale = await db.select({
        id: digitalAssetUploads.id,
        r2Key: digitalAssetUploads.r2Key,
        r2UploadId: digitalAssetUploads.r2UploadId,
    }).from(digitalAssetUploads)
        .where(and(sql`${digitalAssetUploads.status} = 'uploading'`, lt(digitalAssetUploads.createdAt, cutoff)))
        .orderBy(asc(digitalAssetUploads.status), asc(digitalAssetUploads.createdAt))
        .limit(SWEEP_LIMIT)
        .all();
    for (const upload of stale) {
        try {
            await bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).abort().catch(() => undefined);
            await db.update(digitalAssetUploads).set({ status: "aborted", updatedAt: sql`unixepoch()` })
                .where(and(eq(digitalAssetUploads.id, upload.id), eq(digitalAssetUploads.status, "uploading"))).run();
            aborted += 1;
        } catch (error) {
            console.warn(`[digital] upload ${upload.id} abort failed:`, error instanceof Error ? error.name : "unknown");
        }
    }

    // Replaced files: a completed upload the asset no longer points at.
    const replaced = await db.select({ id: digitalAssetUploads.id, r2Key: digitalAssetUploads.r2Key })
        .from(digitalAssetUploads)
        .innerJoin(digitalAssets, eq(digitalAssets.id, digitalAssetUploads.assetId))
        .where(and(
            eq(digitalAssetUploads.status, "complete"),
            lt(digitalAssetUploads.updatedAt, cutoff),
            sql`(${digitalAssets.currentR2Key} IS NULL OR ${digitalAssets.currentR2Key} <> ${digitalAssetUploads.r2Key})`,
        ))
        .limit(SWEEP_LIMIT)
        .all();
    for (const upload of replaced) {
        try {
            await bucket.delete(upload.r2Key);
            await db.update(digitalAssetUploads).set({ status: "aborted", updatedAt: sql`unixepoch()` })
                .where(eq(digitalAssetUploads.id, upload.id)).run();
            aborted += 1;
        } catch (error) {
            console.warn(`[digital] replaced object ${upload.id} delete failed:`, error instanceof Error ? error.name : "unknown");
        }
    }
    return { aborted };
}
