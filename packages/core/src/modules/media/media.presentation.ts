import { getCurrentPublicMediaUrl } from "../../integrations/storage";

type PosterStatus = "ready" | "trashed" | "deleting" | "deleted";

export type MediaPosterProjection = {
    posterObjectKey: string | null;
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
    T extends { objectKey: string } & MediaPosterProjection,
>(row: T) {
    const {
        posterObjectKey,
        posterKind,
        posterStatus,
        ...mediaRow
    } = row;
    const posterIsUsable = posterKind === "image"
        && (posterStatus === "ready" || posterStatus === "trashed")
        && Boolean(posterObjectKey);
    const resolvedPosterUrl = posterIsUsable
        ? getCurrentPublicMediaUrl(posterObjectKey!)
        : null;

    return {
        ...mediaRow,
        url: getCurrentPublicMediaUrl(row.objectKey),
        // A missing storage base must not turn an internal object key into a
        // browser URL. The admin uses its neutral video placeholder instead.
        posterUrl: resolvedPosterUrl === posterObjectKey ? null : resolvedPosterUrl,
    };
}
