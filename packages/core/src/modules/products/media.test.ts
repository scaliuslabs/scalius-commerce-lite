import { describe, expect, it } from "vitest";
import {
    resolveProductCardImages,
    resolveProductImageRepresentation,
    resolveSkuImageRepresentation,
    type ProductMediaProjection,
} from "./media";

function item(overrides: Partial<ProductMediaProjection> = {}): ProductMediaProjection {
    return {
        id: "pmed_image_1",
        mediaId: "media_image_1",
        kind: "image",
        url: "/api/v1/media/image-1.webp",
        posterMediaId: null,
        posterUrl: null,
        altText: "Product image",
        filename: "image-1.webp",
        caption: null,
        width: 800,
        height: 800,
        durationMs: null,
        isPrimary: true,
        sortOrder: 0,
        status: "ready",
        ...overrides,
    };
}

describe("product media representation", () => {
    it("returns no placeholder for an empty gallery", () => {
        expect(resolveProductImageRepresentation([])).toBeNull();
        expect(resolveSkuImageRepresentation([], null)).toBeNull();
    });

    it("prefers the featured image even when its order is not first", () => {
        const result = resolveProductImageRepresentation([
            item({ id: "pmed_ordered", mediaId: "media_ordered", isPrimary: false, sortOrder: 0 }),
            item({ id: "pmed_featured", mediaId: "media_featured", isPrimary: true, sortOrder: 1 }),
        ]);
        expect(result).toMatchObject({ productMediaId: "pmed_featured", source: "featured-image" });
    });

    it("uses a featured video poster before any ordered image", () => {
        const result = resolveProductImageRepresentation([
            item({
                id: "pmed_video",
                mediaId: "media_video",
                kind: "video",
                url: "/api/v1/media/video.mp4",
                posterMediaId: "media_poster",
                posterUrl: "/api/v1/media/poster.webp",
                isPrimary: true,
                durationMs: 2_000,
            }),
            item({ id: "pmed_ordered", isPrimary: false, sortOrder: 1 }),
        ]);
        expect(result).toEqual({
            productMediaId: "pmed_video",
            mediaId: "media_poster",
            url: "/api/v1/media/poster.webp",
            altText: "Product image",
            source: "featured-video-poster",
        });
    });

    it("falls through from an unposted featured video to an ordered image then video poster", () => {
        const featured = item({
            id: "pmed_video",
            kind: "video",
            url: "/api/v1/media/video.mp4",
            posterMediaId: null,
            posterUrl: null,
            isPrimary: true,
        });
        expect(resolveProductImageRepresentation([
            featured,
            item({ id: "pmed_ordered", mediaId: "media_ordered", isPrimary: false, sortOrder: 1 }),
        ])).toMatchObject({ productMediaId: "pmed_ordered", source: "ordered-image" });

        expect(resolveProductImageRepresentation([
            featured,
            item({
                id: "pmed_later_video",
                mediaId: "media_later_video",
                kind: "video",
                isPrimary: false,
                sortOrder: 1,
                posterMediaId: "media_later_poster",
                posterUrl: "/api/v1/media/later-poster.webp",
            }),
        ])).toMatchObject({
            productMediaId: "pmed_later_video",
            mediaId: "media_later_poster",
            source: "ordered-video-poster",
        });
    });

    it("keeps an exact SKU image above the product fallback and never uses a video exactly", () => {
        const exact = item({ id: "pmed_exact", mediaId: "media_exact", isPrimary: false, sortOrder: 1, status: "trashed" });
        const featured = item({ id: "pmed_featured", mediaId: "media_featured" });
        expect(resolveSkuImageRepresentation([featured, exact], exact.id)).toMatchObject({
            productMediaId: exact.id,
            source: "exact-sku",
        });
        const video = item({ id: "pmed_video", kind: "video", isPrimary: false, sortOrder: 2 });
        expect(resolveSkuImageRepresentation([featured, video], video.id)).toMatchObject({
            productMediaId: featured.id,
            source: "featured-image",
        });
    });
});

describe("product card images", () => {
    it("pairs the primary photo with the next gallery photo and skips videos", () => {
        const result = resolveProductCardImages([
            item({ id: "pmed_video", mediaId: "media_video", kind: "video", url: "/v.mp4", isPrimary: false, sortOrder: 0 }),
            item({ id: "pmed_featured", mediaId: "media_featured", url: "/featured.webp", isPrimary: true, sortOrder: 2 }),
            item({ id: "pmed_second", mediaId: "media_second", url: "/second.webp", isPrimary: false, sortOrder: 1 }),
            item({ id: "pmed_third", mediaId: "media_third", url: "/third.webp", isPrimary: false, sortOrder: 3 }),
        ]);
        expect(result).toEqual({
            imageUrl: "/featured.webp",
            imageMediaId: "media_featured",
            imageAlt: "Product image",
            secondaryImageUrl: "/second.webp",
        });
    });

    it("has no hover photo for a single photo, a repeated photo, or an empty gallery", () => {
        expect(resolveProductCardImages([item()]).secondaryImageUrl).toBeNull();
        expect(resolveProductCardImages([
            item(),
            item({ id: "pmed_again", isPrimary: false, sortOrder: 1 }),
        ]).secondaryImageUrl).toBeNull();
        expect(resolveProductCardImages([])).toEqual({
            imageUrl: null,
            imageMediaId: null,
            imageAlt: null,
            secondaryImageUrl: null,
        });
    });
});
