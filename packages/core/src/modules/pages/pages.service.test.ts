import { describe, expect, it, vi } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { ForbiddenError } from "@scalius/core/errors";
import {
    createPage,
    publicPageVisibilityCondition,
    updatePage,
} from "./pages.service";

describe("publicPageVisibilityCondition", () => {
    it("requires published, not deleted, and not scheduled for the future", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicPageVisibilityCondition());

        expect(query.sql).toContain('"pages"."deleted_at" is null');
        expect(query.sql).toContain('"pages"."is_published" = ?');
        expect(query.sql).toContain('"pages"."published_at" is null');
        expect(query.sql).toContain('"pages"."published_at" <= unixepoch()');
        expect(query.params).toEqual([1]);
    });
});

describe("page publication authority", () => {
    const publishedPage = {
        title: "Published page",
        slug: "published-page",
        content: "<p>Content</p>",
        metaTitle: null,
        metaDescription: null,
        canonicalPath: null,
        noIndex: false,
        excludeFromSitemap: false,
        isPublished: true,
        publishedAt: null,
        sortOrder: 0,
        hideHeader: false,
        hideFooter: false,
        hideTitle: false,
        featuredImage: null,
    };

    it("requires publish authority to create a published page", async () => {
        await expect(createPage({} as never, publishedPage))
            .rejects.toBeInstanceOf(ForbiddenError);
    });

    it("does not let ordinary edit permission publish a draft", async () => {
        const db = {
            select: () => ({
                from: () => ({
                    where: () => ({
                        get: async () => ({
                            id: "page_1",
                            slug: "published-page",
                            isPublished: false,
                        }),
                    }),
                }),
            }),
            update: vi.fn(),
        };

        await expect(
            updatePage(db as never, "page_1", {
                canonicalPath: undefined,
                isPublished: true,
            }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(db.update).not.toHaveBeenCalled();
    });

    it("does not let ordinary edit permission schedule publication", async () => {
        const db = {
            select: () => ({
                from: () => ({
                    where: () => ({
                        get: async () => ({
                            id: "page_1",
                            slug: "published-page",
                            isPublished: false,
                            publishedAt: null,
                        }),
                    }),
                }),
            }),
            update: vi.fn(),
        };

        await expect(
            updatePage(db as never, "page_1", {
                canonicalPath: undefined,
                publishedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(db.update).not.toHaveBeenCalled();
    });
});
