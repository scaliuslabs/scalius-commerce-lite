import { beforeEach, describe, expect, it } from "vitest";
import { initPublicMediaUrl } from "../../integrations/storage";
import { presentMediaProjection } from "./media.presentation";

function row(overrides: Partial<Parameters<typeof presentMediaProjection>[0]> = {}) {
    return {
        id: "media_video_1",
        objectKey: "media/media_video_1.mp4",
        posterMediaId: "media_image_1",
        posterObjectKey: "media/media_image_1.jpg",
        posterKind: "image" as const,
        posterStatus: "ready" as const,
        ...overrides,
    };
}

describe("presentMediaProjection", () => {
    beforeEach(() => {
        initPublicMediaUrl("https://media.example.com");
    });

    it("derives the video and retained image poster URLs without exposing join fields", () => {
        expect(presentMediaProjection(row())).toEqual({
            id: "media_video_1",
            objectKey: "media/media_video_1.mp4",
            posterMediaId: "media_image_1",
            url: "https://media.example.com/media/media_video_1.mp4",
            posterUrl: "https://media.example.com/media/media_image_1.jpg",
        });
        expect(presentMediaProjection(row({ posterStatus: "trashed" })).posterUrl)
            .toBe("https://media.example.com/media/media_image_1.jpg");
    });

    it.each([
        ["missing", { posterObjectKey: null, posterKind: null, posterStatus: null }],
        ["non-image", { posterKind: "video" as const }],
        ["deleting", { posterStatus: "deleting" as const }],
        ["deleted", { posterStatus: "deleted" as const }],
    ])("fails closed for a %s poster", (_case, overrides) => {
        expect(presentMediaProjection(row(overrides)).posterUrl).toBeNull();
    });

    it("never presents a raw poster object key as a URL", () => {
        initPublicMediaUrl("");
        expect(presentMediaProjection(row()).posterUrl).toBeNull();
    });
});
