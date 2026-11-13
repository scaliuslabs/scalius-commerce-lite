import { media } from "@scalius/database/schema";
import { sql } from "drizzle-orm";
import { storedObjectKeyUrl } from "../../integrations/storage";

/**
 * SQL for the storage key a (left-joined) media row is published as: its
 * largest rendition when one exists, else the original. Pass the result to
 * storedObjectKeyUrl(); it is NULL when the join found no media.
 */
export function publishedMediaObjectKey() {
    return sql<string | null>`CASE WHEN ${media.variantWidth} IS NULL THEN ${media.objectKey} ELSE ${media.objectKey} || '/' || ${media.variantWidth} || '.webp' END`;
}

type PosterStatus = "ready" | "trashed" | "deleting" | "deleted";

export type MediaPosterProjection = {
    posterObjectKey: string | null;
    posterVariantWidth: number | null;
    posterKind: "image" | "video" | null;
    posterStatus: PosterStatus | null;
};

/**
 * Converts storage keys into current public URLs without leaking the joined
 * poster columns into the media response. Trashed poster images remain usable
 * for retained references; deletion claims fail closed to the neutral video
 * placeholder.
 */
export function presentMediaProjection<
    T extends { id: string; objectKey: string; variantWidth?: number | null } & MediaPosterProjection,
>(row: T) {
    const {
        posterObjectKey,
        posterVariantWidth,
        posterKind,
        posterStatus,
        ...mediaRow
    } = row;
    const posterIsUsable = posterKind === "image"
        && (posterStatus === "ready" || posterStatus === "trashed")
        && Boolean(posterObjectKey);
    const resolvedPosterUrl = posterIsUsable
        ? storedObjectKeyUrl(posterObjectKey, { variantWidth: posterVariantWidth, source: `poster of media ${row.id}` })
        : null;

    return {
        ...mediaRow,
        // Staff still see a row whose stored key cannot be published (to replace or delete it), without a URL.
        url: storedObjectKeyUrl(row.objectKey, { variantWidth: row.variantWidth, source: `media ${row.id}` }) ?? "",
        // A missing storage base must not turn an internal object key into a
        // browser URL. The admin uses its neutral video placeholder instead.
        posterUrl: resolvedPosterUrl?.startsWith(posterObjectKey!) ? null : resolvedPosterUrl,
    };
}
