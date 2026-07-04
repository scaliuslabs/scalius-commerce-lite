import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTS_MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("storefront product query boundaries", () => {
    it("requires buyer-resolvable SKUs before products enter public catalog reads", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        expect(source).toContain("publicProductBaseConditions");
        expect(source).toContain("publicProductHasBuyerResolvableSku");
        expect(source).toContain("publicProductHasCustomerOptions");
        expect(source).toContain("const conditions: (SQL | undefined)[] = publicProductBaseConditions();");
        expect(source).toContain("const conditions: SQL[] = publicProductBaseConditions();");
        expect(source).toContain("publicProductHasBuyerResolvableSku(),");
        expect(source).toContain("normalizeDefaultSkuOptions");
        expect(source).toContain("hasCustomerOptions: publicProductHasCustomerOptions(sql`${products.id}`).as(\"hasCustomerOptions\")");
        expect(source).toContain("hasVariants: Boolean(hasCustomerOptions)");
        expect(source).toContain("variant.isDefault !== true");
    });

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
            "const [imageMap, categoriesData] = await Promise.all([",
        );
        const imagesReadIndex = source.indexOf(
            "readPrimaryProductImageMap(db, productIds)",
            enrichmentWaveIndex,
        );
        const categoriesReadIndex = source.indexOf(".from(categories)", enrichmentWaveIndex);
        const imageMapIndex = source.indexOf("const [imageMap, categoriesData]", enrichmentWaveIndex);
        const categoryMapIndex = source.indexOf("categoryMap = new Map", enrichmentWaveIndex);

        expect(categoryIdsIndex).toBeGreaterThan(-1);
        expect(enrichmentWaveIndex).toBeGreaterThan(categoryIdsIndex);
        expect(imagesReadIndex).toBeGreaterThan(enrichmentWaveIndex);
        expect(categoriesReadIndex).toBeGreaterThan(enrichmentWaveIndex);
        expect(imageMapIndex).toBe(enrichmentWaveIndex);
        expect(categoryMapIndex).toBeGreaterThan(imageMapIndex);
    });

    it("keeps category products on the shared storefront list core", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const conditionsHelperIndex = source.indexOf("function buildStorefrontProductConditions");
        const sortHelperIndex = source.indexOf("function getStorefrontProductOrderBy");
        const attributeHelperIndex = source.indexOf("function buildAttributeProductSubquery");
        const singleFilterBranchIndex = source.indexOf(
            "if (attributeFilters.length === 1) {",
            attributeHelperIndex,
        );
        const singleFilterAliasIndex = source.indexOf(
            ".as(alias);",
            singleFilterBranchIndex,
        );
        const multiFilterGroupIndex = source.indexOf(
            ".groupBy(productAttributeValues.productId)",
            singleFilterAliasIndex,
        );
        const attributeInnerJoinIndex = source.indexOf(
            ".innerJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))",
            attributeHelperIndex,
        );
        const attributeLeftJoinIndex = source.indexOf(
            ".leftJoin(productAttributes",
            attributeHelperIndex,
        );
        const categoryHelperIndex = source.indexOf("export async function getStorefrontCategoryProducts");
        const newestSortIndex = source.indexOf(
            "return desc(products.createdAt);",
            sortHelperIndex,
        );
        const categoryConditionsIndex = source.indexOf(
            "const conditions = buildStorefrontProductConditions({",
            categoryHelperIndex,
        );
        const categorySortIndex = source.indexOf(
            "const orderBy = getStorefrontProductOrderBy(sort);",
            categoryHelperIndex,
        );
        const categoryAttributeIndex = source.indexOf(
            'buildAttributeProductSubquery(db, attributeFilters, "category_filtered_products")',
            categoryHelperIndex,
        );
        const guardedDiscountSortIndex = source.indexOf(
            "WHEN ${products.price} > 0 AND ${products.discountType} = 'flat'",
            sortHelperIndex,
        );

        expect(conditionsHelperIndex).toBeGreaterThan(-1);
        expect(sortHelperIndex).toBeGreaterThan(conditionsHelperIndex);
        expect(attributeHelperIndex).toBeGreaterThan(sortHelperIndex);
        expect(singleFilterBranchIndex).toBeGreaterThan(attributeHelperIndex);
        expect(singleFilterAliasIndex).toBeGreaterThan(singleFilterBranchIndex);
        expect(multiFilterGroupIndex).toBeGreaterThan(singleFilterAliasIndex);
        expect(attributeInnerJoinIndex).toBeGreaterThan(attributeHelperIndex);
        expect(attributeLeftJoinIndex).toBe(-1);
        expect(categoryHelperIndex).toBeGreaterThan(attributeHelperIndex);
        expect(categoryConditionsIndex).toBeGreaterThan(categoryHelperIndex);
        expect(categorySortIndex).toBeGreaterThan(categoryHelperIndex);
        expect(categoryAttributeIndex).toBeGreaterThan(categoryHelperIndex);
        expect(guardedDiscountSortIndex).toBeGreaterThan(sortHelperIndex);
        expect(newestSortIndex).toBeGreaterThan(sortHelperIndex);
    });
});
