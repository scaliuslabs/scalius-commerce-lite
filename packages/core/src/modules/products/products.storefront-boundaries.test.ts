import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTS_MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

function getFunctionBody(source: string, functionName: string): string {
    const start = source.indexOf(`export async function ${functionName}`);
    expect(start).toBeGreaterThan(-1);
    const nextFunction = source.indexOf("\nexport async function ", start + 1);
    return source.slice(start, nextFunction === -1 ? undefined : nextFunction);
}

describe("storefront product query boundaries", () => {
    it("requires buyer-resolvable SKUs before products enter public catalog reads", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        expect(source).toContain("publicProductBaseConditions");
        expect(source).toContain("publicProductHasBuyerResolvableSku");
        expect(source).toContain("publicProductHasCustomerOptions");
        expect(source).toContain("publicProductHasAvailableBuyerSku");
        expect(source).toContain("const conditions: (SQL | undefined)[] = publicProductBaseConditions();");
        expect(source).toContain("const conditions: SQL[] = publicProductBaseConditions();");
        expect(source).toContain("publicProductHasBuyerResolvableSku(),");
        expect(source).toContain("normalizeDefaultSkuOptions");
        expect(source).toContain("hasCustomerOptions: publicProductHasCustomerOptions(sql`${products.id}`).as(\"hasCustomerOptions\")");
        expect(source).toContain("availableForSale: publicProductHasAvailableBuyerSku(sql`${products.id}`).as(\"availableForSale\")");
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

    it("keeps feed projection dedicated instead of expanding normal product listings", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const listBody = getFunctionBody(source, "getStorefrontProducts");
        const feedBody = getFunctionBody(source, "getStorefrontFeedProducts");

        expect(source).toContain("StorefrontFeedProductFilterInput");
        expect(source).toContain("StorefrontFeedProductVariant");
        expect(feedBody).toContain("description: products.description");
        expect(feedBody).toContain("canonicalPath: products.canonicalPath");
        expect(feedBody).toContain("attributes: attributeMap.get(product.id) ?? []");
        expect(feedBody).toContain("variants: variantMap.get(product.id) ?? []");
        expect(listBody).not.toContain("readStorefrontFeedAttributeMap");
        expect(listBody).not.toContain("readStorefrontFeedVariantMap");
        expect(listBody).not.toContain("attributes:");
        expect(listBody).not.toContain("variants:");
    });

    it("keeps feed page rows/count and enrichment bulked by page product IDs", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );
        const feedBody = getFunctionBody(source, "getStorefrontFeedProducts");

        const readWaveIndex = feedBody.indexOf(
            "const [productsList, totalCount] = await Promise.all([",
        );
        const productIdsIndex = feedBody.indexOf(
            "const productIds = productsList.map((product) => product.id);",
        );
        const enrichmentWaveIndex = feedBody.indexOf(
            "const [imageMap, categoriesData, attributeMap, variantMap] = await Promise.all([",
        );

        expect(readWaveIndex).toBeGreaterThan(-1);
        expect(feedBody.indexOf("query.orderBy(orderBy).limit(limit).offset(offset).all()", readWaveIndex)).toBeGreaterThan(readWaveIndex);
        expect(feedBody.indexOf("countQuery.get()", readWaveIndex)).toBeGreaterThan(readWaveIndex);
        expect(productIdsIndex).toBeGreaterThan(readWaveIndex);
        expect(enrichmentWaveIndex).toBeGreaterThan(productIdsIndex);
        expect(feedBody.indexOf("readPrimaryProductImageMap(db, productIds)", enrichmentWaveIndex)).toBeGreaterThan(enrichmentWaveIndex);
        expect(feedBody.indexOf("readStorefrontFeedAttributeMap(db, productIds)", enrichmentWaveIndex)).toBeGreaterThan(enrichmentWaveIndex);
        expect(feedBody.indexOf("readStorefrontFeedVariantMap(db, productIds)", enrichmentWaveIndex)).toBeGreaterThan(enrichmentWaveIndex);
    });

    it("keeps feed variants buyer-safe, normalized, and page-wide instead of N+1", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );
        const variantHelperStart = source.indexOf("async function readStorefrontFeedVariantMap");
        const feedBody = getFunctionBody(source, "getStorefrontFeedProducts");
        const variantHelperEnd = source.indexOf("\n// ─", variantHelperStart);
        const variantHelper = source.slice(variantHelperStart, variantHelperEnd);

        expect(variantHelperStart).toBeGreaterThan(-1);
        expect(variantHelper).toContain("id: productVariants.id");
        expect(variantHelper).toContain("productId: productVariants.productId");
        expect(variantHelper).toContain("size: productVariants.size");
        expect(variantHelper).toContain("color: productVariants.color");
        expect(variantHelper).toContain("weight: productVariants.weight");
        expect(variantHelper).toContain("sku: productVariants.sku");
        expect(variantHelper).toContain("barcode: productVariants.barcode");
        expect(variantHelper).toContain("barcodeType: productVariants.barcodeType");
        expect(variantHelper).toContain("price: productVariants.price");
        expect(variantHelper).toContain("stock: productVariants.stock");
        expect(variantHelper).toContain("reservedStock: productVariants.reservedStock");
        expect(variantHelper).toContain("isDefault: productVariants.isDefault");
        expect(variantHelper).toContain("trackInventory: productVariants.trackInventory");
        expect(variantHelper).toContain("discountType: productVariants.discountType");
        expect(variantHelper).toContain("discountPercentage: productVariants.discountPercentage");
        expect(variantHelper).toContain("discountAmount: productVariants.discountAmount");
        expect(variantHelper).toContain("colorSortOrder: productVariants.colorSortOrder");
        expect(variantHelper).toContain("sizeSortOrder: productVariants.sizeSortOrder");
        expect(variantHelper).toContain("deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`");
        expect(variantHelper).toContain("inArray(productVariants.productId, productIds)");
        expect(variantHelper).toContain("isNull(productVariants.deletedAt)");
        expect(variantHelper).toContain("normalizeDefaultSkuOptions({");
        expect(variantHelper).not.toContain("createdAt");
        expect(variantHelper).not.toContain("updatedAt");
        expect(feedBody).not.toContain("eq(productVariants.productId, product.id)");
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
        const invalidListingSearchIndex = source.indexOf("conditions.push(cond ?? sql`0 = 1`);");
        const invalidLookupSearchIndex = source.indexOf("conditions.push(searchCondition ?? sql`0 = 1`);");
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
        expect(invalidListingSearchIndex).toBeGreaterThan(conditionsHelperIndex);
        expect(invalidLookupSearchIndex).toBeGreaterThan(categoryHelperIndex);
        expect(categoryHelperIndex).toBeGreaterThan(attributeHelperIndex);
        expect(categoryConditionsIndex).toBeGreaterThan(categoryHelperIndex);
        expect(categorySortIndex).toBeGreaterThan(categoryHelperIndex);
        expect(categoryAttributeIndex).toBeGreaterThan(categoryHelperIndex);
        expect(guardedDiscountSortIndex).toBeGreaterThan(sortHelperIndex);
        expect(newestSortIndex).toBeGreaterThan(sortHelperIndex);
    });
});
