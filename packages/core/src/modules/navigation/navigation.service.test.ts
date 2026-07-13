import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
} from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
    getPublicCategoryById: vi.fn(),
    getStorefrontProducts: vi.fn(),
}));

vi.mock("../categories/categories.storefront", () => ({
    getPublicCategoryById: mocks.getPublicCategoryById,
}));

vi.mock("../products/products.storefront", () => ({
    getStorefrontProducts: mocks.getStorefrontProducts,
}));

import {
    getNavigationMenus,
    getNavigationPreviewProductCount,
    saveNavigationConfig,
} from "./navigation.service";

function createNavigationMenusDb(headerConfig: string, footerConfig = "{}") {
    return {
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                limit: vi.fn(async () => [{ headerConfig, footerConfig }]),
            })),
        })),
    };
}

describe("navigation preview product count", () => {
    const db = {} as Database;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses storefront product filters so preview counts match public category pages", async () => {
        mocks.getPublicCategoryById.mockResolvedValue({ id: "cat_1" });
        mocks.getStorefrontProducts.mockResolvedValue({
            products: [],
            pagination: { total: 12, page: 1, limit: 1, totalPages: 12 },
        });

        const result = await getNavigationPreviewProductCount(db, {
            categoryId: "cat_1",
            search: "shirt",
            minPrice: 10,
            maxPrice: 100,
            freeDelivery: "true",
            hasDiscount: "false",
            attributeFilters: [{ slug: "color", value: "Blue" }],
        });

        expect(result).toEqual({ count: 12 });
        expect(mocks.getStorefrontProducts).toHaveBeenCalledWith(db, {
            category: "cat_1",
            search: "shirt",
            minPrice: 10,
            maxPrice: 100,
            freeDelivery: "true",
            hasDiscount: "false",
            page: 1,
            limit: 1,
            sort: "newest",
            attributeFilters: [{
                id: "color",
                name: "color",
                slug: "color",
                values: ["Blue"],
            }],
        });
    });

    it("rejects missing or deleted public categories before counting products", async () => {
        mocks.getPublicCategoryById.mockResolvedValue(null);

        await expect(
            getNavigationPreviewProductCount(db, { categoryId: "cat_deleted" }),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(mocks.getStorefrontProducts).not.toHaveBeenCalled();
    });
});

describe("stored navigation authority", () => {
    it("returns a resolved projection without persisting a copied href", async () => {
        const db = createNavigationMenusDb(JSON.stringify({
            navigation: [{
                id: "returns",
                target: { type: "internal_path", path: "/returns" },
                labelMode: "custom",
                customLabel: "Returns",
            }],
        }));

        await expect(getNavigationMenus(db as never)).resolves.toMatchObject({
            headerConfig: {
                navigation: [{ title: "Returns", href: "/returns" }],
            },
        });
    });

    it("fails explicitly instead of returning empty menus for invalid settings", async () => {
        const db = createNavigationMenusDb("{not-json");

        await expect(getNavigationMenus(db as never))
            .rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    it("rejects unsafe links before any settings write", async () => {
        const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };

        await expect(saveNavigationConfig(db as never, "header", {
            navigation: [{
                id: "unsafe",
                target: { type: "external_url", url: "data:text/html,boom" },
                labelMode: "custom",
                customLabel: "Unsafe",
            }],
        })).rejects.toBeInstanceOf(ValidationError);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
    });
});
