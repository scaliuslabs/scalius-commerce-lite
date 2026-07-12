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
    it("sorts percentage-discounted prices at stored precision", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );
        const helperStart = source.indexOf("function getStorefrontProductOrderBy");
        const helperEnd = source.indexOf(
            "\nfunction buildAttributeProductSubquery",
            helperStart,
        );
        const sortHelper = source.slice(helperStart, helperEnd);

        expect(helperStart).toBeGreaterThan(-1);
        expect(sortHelper).toContain(
            "${products.price} * (1 - ${products.discountPercentage} / 100.0)",
        );
        expect(sortHelper).not.toContain("ROUND(");
    });

    it("requires buyer-resolvable SKUs before products enter public catalog reads", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        expect(source).toContain("publicProductBaseConditions");
        expect(source).toContain("publicProductHasBuyerResolvableSku");
        expect(source).toContain("buildBuyerCatalogPricingProjection");
        expect(source).toContain("const conditions: (SQL | undefined)[] = publicProductBaseConditions();");
        expect(source).toContain("const conditions: SQL[] = publicProductBaseConditions();");
        expect(source).toContain("publicProductHasBuyerResolvableSku(),");
        expect(source).toContain("normalizeDefaultSkuOptions");
        expect(source).toContain("hasCustomerOptions: buyerPricing.hasCustomerOptions");
        expect(source).toContain("availableForSale: buyerPricing.availableForSale");
        expect(source).toContain(".innerJoin(buyerPricing, eq(products.id, buyerPricing.productId))");
        expect(source).toContain("hasVariants: Boolean(hasCustomerOptions)");
        expect(source).toContain("variant.isDefault !== true");
    });

    it("keeps product list rows and count in one read wave", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const countQueryIndex = source.indexOf("let countQuery = db");
        const catalogReaderIndex = source.indexOf("async function readStorefrontCatalogPage");
        const readWaveIndex = source.indexOf(
            "const [productsList, totalCount, rawPriceRange, facetRows] = await Promise.all([",
            catalogReaderIndex,
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

        const catalogReaderIndex = source.indexOf("async function readStorefrontCatalogPage");
        const categoryIdsIndex = source.indexOf("const categoryIds = scope.fixedCategory", catalogReaderIndex);
        const enrichmentWaveIndex = source.indexOf(
            "const [imageMap, categoriesData] = await Promise.all([",
            categoryIdsIndex,
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

    it("carries merchant option metadata only in feed and detail projections", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const listBody = getFunctionBody(source, "getStorefrontProducts");
        const feedBody = getFunctionBody(source, "getStorefrontFeedProducts");
        const detailBody = getFunctionBody(source, "getStorefrontProductBySlug");

        expect(feedBody).toContain("loadProductOptions(db, productIds)");
        expect(feedBody).toContain("options: (optionMap.get(product.id) ?? [])");
        expect(detailBody).toContain("loadProductOptions(db, [product.id])");
        expect(detailBody).toContain("options: optionMap.get(product.id) ?? []");
        expect(listBody).not.toContain("loadProductOptions");
    });

    it("lets feed reuse safe public filters with UCP lookup support", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const lookupHelperStart = source.indexOf("function buildProductLookupCondition");
        const lookupHelperEnd = source.indexOf("\nfunction buildStorefrontProductConditions", lookupHelperStart);
        const lookupHelper = source.slice(lookupHelperStart, lookupHelperEnd);
        const listBody = getFunctionBody(source, "getStorefrontProducts");
        const feedBody = getFunctionBody(source, "getStorefrontFeedProducts");
        const catalogReaderStart = source.indexOf("async function readStorefrontCatalogPage");
        const catalogReaderEnd = source.indexOf(
            "/**\n * Returns a paginated list of active storefront products",
            catalogReaderStart,
        );
        const catalogReader = source.slice(catalogReaderStart, catalogReaderEnd);

        expect(source).toContain("const MAX_PUBLIC_LOOKUP_TOKENS = 100;");
        expect(source).toContain("function parsePublicLookupTokens");
        expect(source).toContain(".slice(\n        0,\n        MAX_PUBLIC_LOOKUP_TOKENS,");
        expect(source).toContain("function buildCategoryLookupCondition(category: string): SQL");
        expect(source).toContain("eq(categories.slug, category)");
        expect(source).toContain("buildCategoryLookupCondition(category)");
        expect(lookupHelper).toContain("FROM json_each(${JSON.stringify(lookupTokens)})");
        expect(lookupHelper).toContain("SELECT value FROM public_lookup");
        expect(lookupHelper).toContain("lookup_product.slug = public_lookup.value");
        expect(lookupHelper).toContain("FROM \"product_variants\" AS lookup_variant");
        expect(lookupHelper).toContain("lookup_variant.id = public_lookup.value");
        expect(lookupHelper).toContain("lookup_variant.sku = public_lookup.value");
        expect(lookupHelper).toContain("lookup_variant.deleted_at IS NULL");
        expect(listBody).toContain("return readStorefrontCatalogPage(db, params);");
        expect(catalogReader).toContain("const conditions = buildStorefrontProductConditions(params, {}, buyerPricing);");
        expect(listBody).not.toContain("includeLookupHandles");
        expect(listBody).not.toContain("includeVariantLookups");
        expect(feedBody).toContain("const conditions = buildStorefrontProductConditions(params, {");
        expect(feedBody).toContain("includeLookupHandles: true");
        expect(feedBody).toContain("includeVariantLookups: true");
        expect(feedBody).toContain("includeCategorySearchMatches: true");
        expect(feedBody).toContain("}, buyerPricing);");
        expect(feedBody).toContain("conditions.push(eq(products.excludeFromProductFeed, false));");
        expect(source).toContain("function buildFeedCategorySearchCondition");
        expect(source).toContain('MATCH ${`name : (${sanitized})`}');
        expect(source).toContain("eq(categories.slug, normalizedSlug)");
        expect(source).toContain("MAX_PUBLIC_CATEGORY_SEARCH_SLUG_LENGTH");
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
            "const [imageMap, categoriesData, attributeMap, variantMap, optionMap] = await Promise.all([",
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
        expect(variantHelper).toContain("optionCombinationKey: productVariants.optionCombinationKey");
        expect(variantHelper).toContain("imageId: productVariants.imageId");
        expect(variantHelper).toContain("imageUrl: productImages.url");
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
        expect(variantHelper).toContain("deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`");
        expect(variantHelper).toContain("inArray(productVariants.productId, productIdChunk)");
        expect(variantHelper).toContain("isNull(productVariants.deletedAt)");
        expect(variantHelper).toContain("normalizeDefaultSkuOptions({");
        expect(variantHelper).toContain("loadVariantSelectedOptions(db, rows.map((row) => row.id))");
        expect(variantHelper).toContain("selectedOptions: selectedOptionMap.get(row.id) ?? []");
        expect(variantHelper).not.toContain("createdAt: productVariants.createdAt");
        expect(variantHelper).not.toContain("updatedAt: productVariants.updatedAt");
        expect(feedBody).not.toContain("eq(productVariants.productId, product.id)");
    });

    it("keeps products, categories, and collections on one result-scoped catalog core", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );

        const conditionsHelperIndex = source.indexOf("function buildStorefrontProductConditions");
        const sortHelperIndex = source.indexOf("function getStorefrontProductOrderBy");
        const attributeHelperIndex = source.indexOf("function buildAttributeProductSubquery");
        const multiFilterGroupIndex = source.indexOf(
            ".groupBy(productAttributeValues.productId)",
            attributeHelperIndex,
        );
        const facetHelperIndex = source.indexOf("function buildResultScopedFacetQuery");
        const catalogHelperIndex = source.indexOf("async function readStorefrontCatalogPage");
        const categoryHelperIndex = source.indexOf("export async function getStorefrontCategoryProducts");
        const collectionHelperIndex = source.indexOf("export async function getStorefrontCollectionProducts");
        const listingSearchConditionsIndex = source.indexOf(
            'const searchConditions = [ftsMatch("products_fts", "products", search)];',
            conditionsHelperIndex,
        );
        const newestSortIndex = source.indexOf(
            "return desc(products.createdAt);",
            sortHelperIndex,
        );
        const guardedDiscountSortIndex = source.indexOf(
            "WHEN ${products.price} > 0 AND ${products.discountType} = 'flat'",
            sortHelperIndex,
        );

        expect(conditionsHelperIndex).toBeGreaterThan(-1);
        expect(sortHelperIndex).toBeGreaterThan(conditionsHelperIndex);
        expect(attributeHelperIndex).toBeGreaterThan(sortHelperIndex);
        expect(multiFilterGroupIndex).toBeGreaterThan(attributeHelperIndex);
        expect(source.slice(attributeHelperIndex, facetHelperIndex)).toContain("json_each");
        expect(source.slice(attributeHelperIndex, facetHelperIndex)).toContain("$.values");
        expect(facetHelperIndex).toBeGreaterThan(attributeHelperIndex);
        expect(source.slice(facetHelperIndex, catalogHelperIndex)).toContain(
            "matchesOtherSelectedFacets",
        );
        expect(source.slice(facetHelperIndex, catalogHelperIndex)).toContain(
            "COUNT(DISTINCT CASE",
        );
        expect(catalogHelperIndex).toBeGreaterThan(facetHelperIndex);
        expect(listingSearchConditionsIndex).toBeGreaterThan(conditionsHelperIndex);
        expect(source.indexOf("?? sql`0 = 1`,", listingSearchConditionsIndex)).toBeGreaterThan(
            listingSearchConditionsIndex,
        );
        expect(categoryHelperIndex).toBeGreaterThan(catalogHelperIndex);
        expect(collectionHelperIndex).toBeGreaterThan(categoryHelperIndex);
        expect(source.slice(categoryHelperIndex, collectionHelperIndex)).toContain(
            "return readStorefrontCatalogPage",
        );
        expect(source.slice(collectionHelperIndex)).toContain("CAST(key AS INTEGER)");
        expect(source.slice(catalogHelperIndex, categoryHelperIndex)).toContain(
            "facets: groupResultScopedFacets",
        );
        expect(source.slice(catalogHelperIndex, categoryHelperIndex)).toContain(
            "catalog_price_range_filtered_products",
        );
        expect(guardedDiscountSortIndex).toBeGreaterThan(sortHelperIndex);
        expect(newestSortIndex).toBeGreaterThan(sortHelperIndex);
    });

    it("sorts by raw effective prices without whole-unit SQL rounding", () => {
        const source = readFileSync(
            `${PRODUCTS_MODULE_DIR}/products.storefront.ts`,
            "utf8",
        );
        const sortStart = source.indexOf("function getStorefrontProductOrderBy");
        const sortEnd = source.indexOf("\nfunction buildAttributeProductSubquery", sortStart);
        const sortBody = source.slice(sortStart, sortEnd);

        expect(sortStart).toBeGreaterThan(-1);
        expect(sortEnd).toBeGreaterThan(sortStart);
        expect(sortBody).toContain(
            "products.price} * (1 - ${products.discountPercentage} / 100.0)",
        );
        expect(sortBody).not.toContain("ROUND(");
    });
});
