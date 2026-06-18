import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTS_MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("storefront product query boundaries", () => {
    it("keeps product list rows and count in one read wave", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const countQueryIndex = source.indexOf("let countQuery = db");
        const readWaveIndex = source.indexOf(
            "const [productsList, totalCount] = await Promise.all([",
        );
        const rowsReadIndex = source.indexOf(
            "query.orderBy(orderBy).limit(limit).offset(offset).all()",
            readWaveIndex,
        );
        const countReadIndex = source.indexOf("countQuery.get()", readWaveIndex);
        const oldSequentialReadIndex = source.indexOf(
            "const productsList = await query.orderBy",
        );

        expect(countQueryIndex).toBeGreaterThan(-1);
        expect(readWaveIndex).toBeGreaterThan(countQueryIndex);
        expect(rowsReadIndex).toBeGreaterThan(readWaveIndex);
        expect(countReadIndex).toBeGreaterThan(readWaveIndex);
        expect(oldSequentialReadIndex).toBe(-1);
    });

    it("keeps product list image and category enrichment in one read wave", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const categoryIdsIndex = source.indexOf("const categoryIds = [");
        const enrichmentWaveIndex = source.indexOf(
            "const [images, categoriesData] = await Promise.all([",
        );
        const imagesReadIndex = source.indexOf(".from(productImages)", enrichmentWaveIndex);
        const categoriesReadIndex = source.indexOf(".from(categories)", enrichmentWaveIndex);
        const imageMapIndex = source.indexOf("imageMap = new Map", enrichmentWaveIndex);
        const categoryMapIndex = source.indexOf("categoryMap = new Map", enrichmentWaveIndex);

        expect(categoryIdsIndex).toBeGreaterThan(-1);
        expect(enrichmentWaveIndex).toBeGreaterThan(categoryIdsIndex);
        expect(imagesReadIndex).toBeGreaterThan(enrichmentWaveIndex);
        expect(categoriesReadIndex).toBeGreaterThan(enrichmentWaveIndex);
        expect(imageMapIndex).toBeGreaterThan(enrichmentWaveIndex);
        expect(categoryMapIndex).toBeGreaterThan(imageMapIndex);
    });
});
