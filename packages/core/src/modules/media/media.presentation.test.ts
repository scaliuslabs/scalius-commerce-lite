import { describe, expect, it } from "vitest";
import { withPublicMediaUrl } from "../../integrations/storage";
import { presentMediaProjection } from "./media.presentation";

function row(overrides: Partial<Parameters<typeof presentMediaProjection>[0]> = {}) {
    return {
        id: "media_video_1",
        objectKey: "media/media_video_1.mp4",
        posterMediaId: "media_image_1",
        posterObjectKey: "media/media_image_1.jpg",
        posterVariantWidth: null as number | null,
        posterKind: "image" as const,
        posterStatus: "ready" as const,
        ...overrides,
    };
}

describe("presentMediaProjection", () => {
    const present = (
        overrides: Partial<Parameters<typeof presentMediaProjection>[0]> = {},
        publicUrl = "https://media.example.com",
    ) => withPublicMediaUrl(publicUrl, () => presentMediaProjection(row(overrides)));

    it("derives the video and retained image poster URLs without exposing join fields", () => {
        expect(present()).toEqual({
            id: "media_video_1",
            objectKey: "media/media_video_1.mp4",
            posterMediaId: "media_image_1",
            url: "https://media.example.com/media/media_video_1.mp4",
            posterUrl: "https://media.example.com/media/media_image_1.jpg",
        });
        expect(present({ posterStatus: "trashed" }).posterUrl)
            .toBe("https://media.example.com/media/media_image_1.jpg");
    });

    it.each([
        ["missing", { posterObjectKey: null, posterKind: null, posterStatus: null }],
        ["non-image", { posterKind: "video" as const }],
        ["deleting", { posterStatus: "deleting" as const }],
        ["deleted", { posterStatus: "deleted" as const }],
    ])("fails closed for a %s poster", (_case, overrides) => {
        expect(present(overrides).posterUrl).toBeNull();
    });

    it("publishes the largest pre-generated rendition when one exists", () => {
        const presented = withPublicMediaUrl("https://media.example.com", () => presentMediaProjection({
            ...row({ posterVariantWidth: 1600 }),
            objectKey: "media/media_image_2.png",
            variantWidth: 2400,
        }));
        expect(presented.url).toBe("https://media.example.com/media/media_image_2.png/2400.webp");
        expect(presented.posterUrl).toBe("https://media.example.com/media/media_image_1.jpg/1600.webp");
    });

    it("never presents a raw poster object key as a URL", () => {
        expect(present({}, "").posterUrl).toBeNull();
        expect(present({ posterVariantWidth: 640 }, "").posterUrl).toBeNull();
    });
});
