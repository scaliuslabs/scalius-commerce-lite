// The buyer product page read.
import {
  catalogDiscountedPrice,
  effectiveLowStockThresholdSql,
  loadProductMediaProjections,
  loadProductOptions,
  loadProductPageBlockMedia,
  loadVariantSelectedOptions,
  normalizeDefaultSkuOptions,
  parseStoredEmiSettings,
  presentCatalogPrice,
  presentProductBundleTier,
  type CatalogPriceMinor,
  type ProductBundleRow,
  productBundleTiersByProduct,
  productEmiOffer,
  type ProductMediaProjection,
  type ProductPageBlockMedia,
  type ProductPageContentBlockRow,
  channelOnHandSql,
  productPublishedToChannelSql,
  publicProductHasBuyerResolvableSku,
  readStoredCustomization,
  resolveProductImageRepresentation,
  resolveProductPageContentBlocks,
  resolveSkuImageRepresentation,
  selectActiveProductBundleRows,
  selectProductPageContentBlockRows,
  storeEmiSettingsSql,
} from "../products";
import {
    products,
    categories,
    productVariants,
    productAttributeValues,
    productAttributes,
    attributeGroups,
    productBuyerState,
    brands,
    productReviewStats,
    warrantyPolicies,
} from "@scalius/database/schema";
import { and, asc, sql, eq, isNull } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import { fromMinor } from "@scalius/shared/money";
import { isCustomFieldMoney } from "@scalius/shared/custom-fields";
import { listProductBuyGetOffers } from "../promotions";
import { maskPublicBuyerAvailability } from "@scalius/shared/buyer-availability";
import type { Database } from "@scalius/database/client";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { storeCurrencyFromSql, storePriceIncrementSql } from "../markets";
import {
    marketDecimalPlaces,
    marketListPricesSql,
    marketPriceContextOf,
    marketShopAmountMinor,
    marketShopAmounts,
    priceProductSkus,
    type MarketPriceContext,
    type MarketPricing,
} from "../price-lists";
import { publicCategoryConditions } from "../categories";
import { publicBrandJoinCondition } from "../brands";
import { productPageReviews, reviewStatsSelection } from "./product-reviews";
import {
    DEFAULT_RECOMMENDATION_LIMIT,
    getStorefrontProductRecommendations,
    type ProductRecommendations,
} from "./recommendations";
import { declareProductGallery, deps } from "./declare-deps";
import {
    applyTranslation,
    foldedProductChains,
    foldedTranslationChain,
    localizedSlugSql,
    localizedSlugsSql,
    parseLocalizedSlugs,
    productTranslationRowsSql,
    translationRowsSql,
    translationScopeOf,
    PRODUCT_PAGE_FIELDS,
    type TranslationScope,
} from "../translations";
import type { TranslationRow } from "@scalius/shared/translations";
import {
  groupStorefrontCustomFields,
  presentStorefrontCustomFields,
  selectStorefrontCustomFieldRows,
  selectStorefrontVariantCustomFieldRows,
  type StorefrontCustomFieldRow,
} from "../custom-fields";

// ─────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────

function extractFeatures(description: string | null): string[] {
    if (!description) return [];
    const features: string[] = [];
    const lines = description.split("\n");
    for (const line of lines) {
        if (line.trim().match(/^[-*•]|^\d+\./) && line.trim().length > 2) {
            features.push(line.trim().replace(/^[-*•]|^\d+\./, "").trim());
        }
    }
    return features;
}

/**
 * Returns full storefront product details (variants, images, attributes, related products)
 * for a single product identified by slug.
 */
export async function getStorefrontProductBySlug(db: Database, slug: string, pricing: MarketPricing | null = null) {
    // A presence page in its language (MARKETS-DESIGN D9): the product, its
    // options, values and SKUs, its category and brand, folded into this
    // first statement; nothing at the root but the localized handles.
    const translation = translationScopeOf(pricing);
    const productRow = await db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            priceMinor: products.priceMinor,
            categoryId: products.categoryId,
            productBrandId: products.brandId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            canonicalPath: products.canonicalPath,
            productCondition: products.productCondition,
            noIndex: products.noIndex,
            // Its handle in every language (hreflang alternates), at the root too.
            localizedSlugs: localizedSlugsSql("product", products.id),
            ...(translation ? {
                trRows: productTranslationRowsSql(translation, products.id),
                trSlug: localizedSlugSql(translation, "product", products.id),
                categoryTrRows: translationRowsSql(translation, "category", categories.id),
                categoryTrSlug: localizedSlugSql(translation, "category", categories.id),
                brandTrRows: translationRowsSql(translation, "brand", brands.id),
                brandTrSlug: localizedSlugSql(translation, "brand", brands.id),
            } : {}),
            discountType: products.discountType,
            discountBps: products.discountBps,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            isActive: products.isActive,
            isGiftCard: products.isGiftCard,
            customizationSchema: products.customizationSchema,
            pageTemplate: products.pageTemplate,
            emiEligible: products.emiEligible,
            // The lowest buyer price (the "from" price) for the EMI line.
            buyerFromMinor: productBuyerState.fromMinor,
            storeEmiSettings: storeEmiSettingsSql(),
            storeCurrencyCode: storeCurrencyCodeSql(),
            storePriceIncrementMinor: storePriceIncrementSql(),
            deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            category: {
                id: categories.id,
                name: categories.name,
                slug: categories.slug,
                description: categories.description,
                imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle,
                metaDescription: categories.metaDescription,
                canonicalPath: categories.canonicalPath,
                noIndex: categories.noIndex,
                excludeFromSitemap: categories.excludeFromSitemap,
            },
            // Review stats come with the row (a PK join on the projection).
            ...reviewStatsSelection(),
            // The product's live warranty policy (Wave B §5): its current terms.
            warranty: {
                id: warrantyPolicies.id,
                name: warrantyPolicies.name,
                provider: warrantyPolicies.provider,
                durationValue: warrantyPolicies.durationValue,
                durationUnit: warrantyPolicies.durationUnit,
                replacementDays: warrantyPolicies.replacementDays,
                terms: warrantyPolicies.terms,
            },
            // The published brand record only (never a "Brand" attribute).
            brand: {
                id: brands.id,
                name: brands.name,
                slug: brands.slug,
                canonicalPath: brands.canonicalPath,
            },
        })
        .from(products)
        .leftJoin(categories, and(
            eq(products.categoryId, categories.id),
            ...publicCategoryConditions(),
        ))
        .leftJoin(brands, publicBrandJoinCondition(products.brandId))
        // Only a public projection row prices the EMI line: its cache rules
        // advance p:<id> for public rows (cache-deps product_buyer_state).
        .leftJoin(productBuyerState, and(eq(productBuyerState.productId, products.id), eq(productBuyerState.isPublic, true)))
        .leftJoin(productReviewStats, eq(productReviewStats.productId, products.id))
        .leftJoin(warrantyPolicies, and(
            eq(warrantyPolicies.id, products.warrantyPolicyId),
            isNull(warrantyPolicies.archivedAt),
        ))
        .where(and(
            productBySlugCondition(slug, translation),
            eq(products.isActive, true),
            isNull(products.deletedAt),
            productPublishedToChannelSql(sql`${products.id}`),
            publicProductHasBuyerResolvableSku(),
        ))
        .get();

    if (!productRow) {
        // Any product can take this slug or become public under it, or a
        // localized handle can name one.
        deps.listMembership("all");
        deps.table("products");
        deps.localizedSlugSpace("product");
        return null;
    }
    const {
        productBrandId,
        category,
        brand,
        storeCurrencyCode,
        storePriceIncrementMinor,
        customizationSchema: storedCustomization,
        pageTemplate,
        emiEligible,
        buyerFromMinor,
        storeEmiSettings,
        warranty,
        reviewsEnabled,
        reviewCount,
        ratingAvgCenti,
        count1,
        count2,
        count3,
        count4,
        count5,
        localizedSlugs: localizedSlugsText,
        trRows,
        trSlug,
        categoryTrRows,
        categoryTrSlug,
        brandTrRows,
        brandTrSlug,
        ...sourceProduct
    } = productRow as typeof productRow & {
        trRows?: string | null;
        trSlug?: string | null;
        categoryTrRows?: string | null;
        categoryTrSlug?: string | null;
        brandTrRows?: string | null;
        brandTrSlug?: string | null;
    };
    // The product's own text and handle in the presence's language.
    const productChains = translation ? foldedProductChains(translation, trRows) : new Map<string, TranslationRow[]>();
    const product = translation
        ? applyTranslation(sourceProduct, productChains.get(`product:${sourceProduct.id}`) ?? [], PRODUCT_PAGE_FIELDS, trSlug ?? null)
        : sourceProduct;
    // Its handle in every language, and the source one: the page's alternates.
    const alternateSlugs = parseLocalizedSlugs(localizedSlugsText);
    deps.resourceHandles(translation !== null, "product", product.id);
    // Found by a localized handle: another product can take that handle in the page's language.
    if (sourceProduct.slug !== slug) deps.localizedSlugSpace("product");
    // The product (row, SKUs, options, attributes, content, bundles) and the
    // category and brand rows it joins, published or not.
    deps.product(product.id);
    // Without a category or brand the joined table's rows cannot change the
    // page (the product row would); only its "any row" key covers the read.
    if (product.categoryId) deps.category(product.categoryId);
    else deps.anyCategory();
    if (productBrandId) deps.brand(productBrandId);
    else deps.anyBrand();
    if (translation) {
        deps.translation("category", category?.id);
        deps.translation("brand", brand?.id);
    }
    const translatedCategory = translation && category?.id
        ? applyTranslation(category, foldedTranslationChain(translation, categoryTrRows), CATEGORY_PAGE_FIELDS, categoryTrSlug ?? null)
        : category;
    const translatedBrand = translation && brand?.id
        ? applyTranslation(brand, foldedTranslationChain(translation, brandTrRows), { name: "name" }, brandTrSlug ?? null)
        : brand;
    const storeCurrency = storeCurrencyFromSql(storeCurrencyCode, storePriceIncrementMinor);
    // A presence of a market in its own currency (MARKETS-DESIGN step 6) shows
    // every amount in it: prices from the market rule, and shop-currency
    // amounts (surcharges, bundle prices, offer thresholds) converted at its
    // rate and rounded to its increment, as checkout charges them.
    // (The context was read beside the product row; it is awaited where amounts are presented.)
    const pageMarketPromise = marketPriceContextOf(pricing);
    const mediaMapPromise = loadProductMediaProjections(db, [product.id]);

    const variantRowsPromise = db.select({
        id: productVariants.id,
        productId: productVariants.productId,
        optionCombinationKey: productVariants.optionCombinationKey,
        imageId: productVariants.imageId,
        weight: productVariants.weight,
        sku: productVariants.sku,
        priceMinor: productVariants.priceMinor,
        // The units the online store sells (its linked locations' on-hand).
        stock: channelOnHandSql({ id: sql`${productVariants.id}`, stock: sql`${productVariants.stock}` }).mapWith(Number),
        reservedStock: productVariants.reservedStock,
        isDefault: productVariants.isDefault,
        trackInventory: productVariants.trackInventory,
        lowStockThreshold: effectiveLowStockThresholdSql(),
        barcode: productVariants.barcode,
        barcodeType: productVariants.barcodeType,
        discountType: productVariants.discountType,
        discountBps: productVariants.discountBps,
        discountAmountMinor: productVariants.discountAmountMinor,
        fulfillmentKind: productVariants.fulfillmentKind,
        createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
        deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
        // A presence page's market list prices ride on the SKU rows (none at the root).
        ...(pricing ? { listPrices: marketListPricesSql(sql.raw('"product_variants"."id"'), { presence: pricing.presence }) } : {}),
    }).from(productVariants)
        .where(and(eq(productVariants.productId, product.id), isNull(productVariants.deletedAt)))
        .orderBy(productVariants.createdAt, productVariants.id)
        .all();

    // Content blocks (page order), active bundle tiers and the storefront-visible
    // custom fields of the product and its SKUs: one round trip in the second
    // wave, where the legacy rich-content read used to be.
    const contentPromise = db.batch([
        selectProductPageContentBlockRows(db, product.id),
        selectActiveProductBundleRows(db, [product.id]),
        selectStorefrontCustomFieldRows(db, "product", product.id),
        selectStorefrontVariantCustomFieldRows(db, product.id),
    ] as never).then((results) => {
        const [blockRows, bundleRows, productFieldRows, variantFieldRows] = results as unknown as [
            ProductPageContentBlockRow[],
            ProductBundleRow[],
            StorefrontCustomFieldRow[],
            StorefrontCustomFieldRow[],
        ];
        return {
            blocks: resolveProductPageContentBlocks(blockRows),
            bundles: productBundleTiersByProduct(bundleRows).get(product.id) ?? [],
            customFields: presentStorefrontCustomFields(productFieldRows),
            variantCustomFields: groupStorefrontCustomFields(variantFieldRows),
        };
    });
    // Files the blocks show: a third-wave read, only when a block names one.
    const blockMediaPromise = contentPromise.then(({ blocks }) => loadProductPageBlockMedia(db, blocks.mediaIds));

    const promises: Promise<{ type: string; data: unknown }>[] = [
        mediaMapPromise.then((mediaMap) => ({
            type: "media",
            // Buyers never need the file's name in Files.
            data: (mediaMap.get(product.id) ?? []).map(({ filename: _filename, ...item }) => item),
        })),

        variantRowsPromise.then((res) => ({ type: "variants", data: res })),

        contentPromise.then((data) => ({ type: "content", data })),

        listProductBuyGetOffers(db, product.id, storeCurrency)
            .then(async (offers) => {
                const market = await pageMarketPromise;
                const places = marketDecimalPlaces(market, storeDecimalPlacesFromCode(storeCurrencyCode));
                return {
                    type: "offers",
                    data: offers.map(({ buyAmountMinor, basisPoints, ...offer }) => ({
                        ...offer,
                        // Offer products show base prices: none in another currency (MARKETS-DESIGN step 6).
                        ...(market && market.currencyCode !== market.shopCurrencyCode
                            ? { products: offer.products.map((item) => ({ ...item, price: null })) }
                            : {}),
                        buyAmount: buyAmountMinor === null ? null : fromMinor(marketShopAmountMinor(market, buyAmountMinor), places),
                        percentOff: basisPoints / 100,
                    })),
                };
            }),

        // The specification table: grouped rows in the merchant's order (one
        // statement; the group join adds no round trip).
        db.select({
            name: productAttributes.name,
            value: productAttributeValues.value,
            slug: productAttributes.slug,
            group: attributeGroups.name,
            unit: productAttributes.unit,
            keySpec: productAttributes.keySpec,
        }).from(productAttributeValues)
            .innerJoin(productAttributes, and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                isNull(productAttributes.deletedAt),
            ))
            .leftJoin(attributeGroups, and(
                eq(attributeGroups.id, productAttributes.groupId),
                isNull(attributeGroups.deletedAt),
            ))
            .where(eq(productAttributeValues.productId, product.id))
            .orderBy(
                sql`${attributeGroups.id} IS NULL`,
                asc(attributeGroups.sortOrder),
                asc(attributeGroups.name),
                asc(productAttributes.sortOrder),
                asc(productAttributes.name),
            )
            .then((res: Array<{ name: string; value: string; slug: string; group: string | null; unit: string | null; keySpec: boolean }>) => ({
                type: "attributes",
                data: res.map((row) => ({ ...row, keySpec: Boolean(row.keySpec) })),
            })),
    ];

    // Published reviews: one indexed read in this wave, only when the product
    // has any (the stats came with the product row).
    const reviewsPromise = productPageReviews(db, product.id, {
        reviewsEnabled, reviewCount, ratingAvgCenti, count1, count2, count3, count4, count5,
    });

    promises.push(
        getStorefrontProductRecommendations(db, {
            productIds: [product.id],
            limit: DEFAULT_RECOMMENDATION_LIMIT,
            pricing,
        }).then((data) => ({ type: "recommendations", data })),
    );

    // Options need only the product id, so they join this wave; selected
    // options follow the SKU read while recommendations are still loading,
    // so neither adds a wave of its own.
    const optionMapPromise = loadProductOptions(db, [product.id]);
    const selectedOptionMapPromise = variantRowsPromise.then((rows) =>
        loadVariantSelectedOptions(db, rows.map((variant) => variant.id)));
    const [results, optionMap, selectedOptionMap, blockMedia, reviews] = await Promise.all([
        Promise.all(promises),
        optionMapPromise,
        selectedOptionMapPromise,
        blockMediaPromise,
        reviewsPromise,
    ]);

    const mediaItems = (results.find((r) => r.type === "media")?.data as ProductMediaProjection[]) || [];
    const variants = (results.find((r) => r.type === "variants")?.data as unknown[]) || [];
    const content = results.find((r) => r.type === "content")!.data as Awaited<typeof contentPromise>;
    // The classic page's tabs: every rich-text block in `tabs` (legacy tabs keep their ids).
    const additionalInfo = content.blocks.tabs;
    const recommendations = results.find((r) => r.type === "recommendations")!.data as ProductRecommendations;
    const attributes = (results.find((r) => r.type === "attributes")?.data as unknown[]) || [];
    const offers = (results.find((r) => r.type === "offers")?.data as unknown[]) || [];
    // Gallery and SKU images, the files content blocks show, and attribute
    // names (any definition can be renamed, trashed or restored).
    declareProductGallery(product.id, mediaItems);
    deps.mediaItems(content.blocks.mediaIds);
    deps.anyAttribute();

    interface VariantResult { id: string; productId: string; optionCombinationKey: string | null; imageId: string | null; weight: number | null; sku: string; priceMinor: number; stock: number; reservedStock: number; isDefault: boolean; trackInventory: boolean; lowStockThreshold: number | null; barcode: string | null; barcodeType: string | null; discountType: string | null; discountBps: number; discountAmountMinor: number; fulfillmentKind: string; createdAt: number; deletedAt: number | null; listPrices?: string | null; }
    // The page's market: its SKUs, "from" price and EMI line in its prices
    // (a neutral market and the root keep the rows as read).
    const pageMarket = await pageMarketPromise;
    const presentShopAmount = marketShopAmounts(pageMarket);
    const foreign = pageMarket !== null && pageMarket.currencyCode !== pageMarket.shopCurrencyCode;
    const decimalPlaces = marketDecimalPlaces(pageMarket, storeDecimalPlacesFromCode(storeCurrencyCode));
    const pageCurrency = pageMarket ? { code: pageMarket.currencyCode, priceIncrementMinor: pageMarket.incrementMinor } : storeCurrency;
    const customization = readStoredCustomization(storedCustomization, decimalPlaces, {
        giftCard: product.isGiftCard === true,
        ...(foreign ? { presentShopAmount } : {}),
    });
    const marketPage = priceProductPageInMarket(
        pageMarket,
        product,
        variants as VariantResult[],
        storeCurrency.priceIncrementMinor,
        buyerFromMinor,
    );
    const typedVariants = marketPage.variants;
    const pricedProduct = marketPage.product;
    const productImage = resolveProductImageRepresentation(mediaItems);
    const publicMedia = mediaItems.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        kind: item.kind,
        url: item.url,
        posterMediaId: item.posterMediaId,
        posterUrl: item.posterUrl,
        altText: item.altText,
        caption: item.caption,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        isPrimary: item.isPrimary,
        sortOrder: item.sortOrder,
        status: item.status,
    }));
    const hasVariants = typedVariants.some((variant) =>
        variant.isDefault !== true && Boolean(variant.optionCombinationKey?.trim()),
    );

    const formattedVariants = typedVariants.map((variant) => {
        const v = maskPublicBuyerAvailability(normalizeDefaultSkuOptions(
            presentCatalogPrice(variant, decimalPlaces),
        ));
        const variantImage = resolveSkuImageRepresentation(mediaItems, v.imageId);
        return {
            ...v,
            imageUrl: variantImage?.url ?? null,
            imageMediaId: variantImage?.mediaId ?? null,
            selectedOptions: translateSelectedOptions(translation, productChains, selectedOptionMap.get(variant.id) ?? []),
            /** Storefront-visible custom fields of this SKU, in definition order. */
            customFields: foreign
                ? customFieldsInMarket(content.variantCustomFields.get(variant.id) ?? [], pageMarket!)
                : content.variantCustomFields.get(variant.id) ?? [],
            createdAt: unixToDate(v.createdAt)?.toISOString() || null,
            deletedAt: v.deletedAt ? unixToDate(v.deletedAt)?.toISOString() : null,
        };
    });
    const productPrice = presentCatalogPrice(pricedProduct, decimalPlaces);
    return {
        product: {
            ...productPrice,
            categoryId: category ? product.categoryId : null,
            hasVariants,
            imageUrl: productImage?.url ?? null,
            imageMediaId: productImage?.mediaId ?? null,
            imageAlt: productImage?.altText ?? null,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            deletedAt: product.deletedAt ? unixToDate(product.deletedAt)?.toISOString() : null,
            options: translateOptions(translation, productChains, optionMap.get(product.id) ?? []),
            discountType: pricedProduct.discountType || "percentage",
            freeDelivery: product.freeDelivery || false,
            features: extractFeatures(product.description),
            isGiftCard: product.isGiftCard === true,
            customization: customization.customization,
            requiresCustomization: customization.requiresCustomization,
            // A malformed schema is a product error: checkout refuses the product.
            customizationUnavailable: customization.invalid,
            discountedPrice: catalogDiscountedPrice(pricedProduct, pageCurrency.code, pageCurrency.priceIncrementMinor),
            attributes,
            additionalInfo,
            offers,
            brand: translatedBrand?.id ? translatedBrand : null,
            /**
             * The product's handle by language (`localized_slugs`) and its source
             * handle, its hreflang alternates; absent without a localized handle.
             */
            ...(Object.keys(alternateSlugs).length > 0 ? { localizedSlugs: alternateSlugs, sourceSlug: sourceProduct.slug } : {}),
            /** The product page template id; null is the theme's default. */
            pageTemplate,
            /** Blocks other than the tabs, in placement then page order. */
            contentBlocks: content.blocks.blocks,
            /** The ready files those blocks name. */
            contentBlockMedia: blockMedia satisfies ProductPageBlockMedia[],
            /** Active quantity tiers, priced by checkout exactly as shown. */
            bundles: content.bundles.map((tier) => presentProductBundleTier(
                foreign && tier.discountType === "fixed_price" ? { ...tier, priceMinor: presentShopAmount(tier.priceMinor) } : tier,
                decimalPlaces,
            )),
            /** Storefront-visible custom fields, in definition order (money as `{ amountMinor, currency }` in the page's currency). */
            customFields: foreign ? customFieldsInMarket(content.customFields, pageMarket!) : content.customFields,
            /** Published reviews (summary and the first page); null when the store's reviews are off. */
            reviews,
            /** The product's warranty policy (its current terms); null without one. */
            warranty: warranty?.id
                ? {
                    name: warranty.name,
                    provider: warranty.provider,
                    duration: { value: warranty.durationValue, unit: warranty.durationUnit },
                    replacementDays: warranty.replacementDays,
                    terms: warranty.terms,
                }
                : null,
            // EMI plans are the shop currency's bank offers: none in another currency.
            emi: foreign ? null : productEmiOffer({
                emiEligible: emiEligible === true,
                priceMinor: marketPage.fromMinor,
                settings: parseStoredEmiSettings(storeEmiSettings),
                priceIncrementMinor: storeCurrency.priceIncrementMinor,
                decimalPlaces,
            }),
        },
        category: translatedCategory,
        media: publicMedia,
        variants: formattedVariants,
        recommendations,
    };
}

/** Money custom fields (shop-currency `{ amountMinor, currency }`) in a foreign market's currency (MARKETS-DESIGN step 6). */
function customFieldsInMarket<T extends { type: string; value: unknown }>(fields: readonly T[], market: MarketPriceContext): T[] {
    const present = (value: unknown) => isCustomFieldMoney(value) && value.currency === market.shopCurrencyCode
        ? { amountMinor: marketShopAmountMinor(market, value.amountMinor), currency: market.currencyCode }
        : value;
    return fields.map((field) => {
        if (field.type === "money") return { ...field, value: present(field.value) };
        if (field.type === "list.money" && Array.isArray(field.value)) return { ...field, value: field.value.map(present) };
        return field;
    });
}

/** A category named on its product's page (breadcrumb, description, meta). */
const CATEGORY_PAGE_FIELDS = { name: "name", description: "description", metaTitle: "metaTitle", metaDescription: "metaDescription" } as const;

/**
 * The product a slug names: its source handle first, else a localized handle
 * (the page's language first, else any): a buyer who switched language on a
 * localized URL still reaches the product, whose canonical names its handle.
 */
export function productBySlugCondition(slug: string, translation: TranslationScope | null) {
    const preferred = translation ? sql.raw(`'${translation.locale}'`) : sql`''`;
    return sql`${products.id} = coalesce(
        (SELECT source_product.id FROM ${products} AS source_product WHERE source_product.slug = ${slug}),
        (SELECT handle.resource_id FROM localized_slugs AS handle
            WHERE handle.resource_type = 'product' AND handle.slug = ${slug}
            ORDER BY handle.locale = ${preferred} DESC, handle.locale LIMIT 1)
    )`;
}

function translateOptions<T extends { id: string; name: string; values: Array<{ id: string; value: string }> }>(
    translation: TranslationScope | null,
    chains: ReadonlyMap<string, TranslationRow[]>,
    options: readonly T[],
): T[] {
    if (!translation || chains.size === 0) return options as T[];
    return options.map((option) => ({
        ...applyTranslation(option, chains.get(`product_option:${option.id}`) ?? [], { name: "name" }),
        values: option.values.map((value) => applyTranslation(value, chains.get(`product_option_value:${value.id}`) ?? [], { value: "value" })),
    }));
}

function translateSelectedOptions<T extends { optionDefinitionId: string; optionValueId: string; name: string; value: string }>(
    translation: TranslationScope | null,
    chains: ReadonlyMap<string, TranslationRow[]>,
    selected: readonly T[],
): T[] {
    if (!translation || chains.size === 0) return selected as T[];
    return selected.map((option) => applyTranslation(
        applyTranslation(option, chains.get(`product_option:${option.optionDefinitionId}`) ?? [], { name: "name" }),
        chains.get(`product_option_value:${option.optionValueId}`) ?? [],
        { value: "value" },
    ));
}


/**
 * The product page in its market (MARKETS-DESIGN D5): each SKU's price and
 * discount become its resolved market price (`priceProductSkus`), and the
 * product's price and "from" price (the EMI line) are its card's. A neutral
 * market (and the root) returns the rows exactly as read.
 */
function priceProductPageInMarket<
    TProduct extends CatalogPriceMinor & { id: string },
    TVariant extends CatalogPriceMinor & { id: string; productId: string; isDefault: boolean; optionCombinationKey: string | null; trackInventory: boolean; stock: number; reservedStock: number; listPrices?: string | null },
>(
    market: MarketPriceContext | null,
    product: TProduct,
    variants: readonly TVariant[],
    priceIncrementMinor: number,
    buyerFromMinor: number | null,
): { product: TProduct; variants: Array<Omit<TVariant, "listPrices">>; fromMinor: number | null } {
    const priced = priceProductSkus(market, new Map([[product.id, product]]), variants, priceIncrementMinor);
    const card = priced.productPrices.get(product.id);
    return {
        product: card ? { ...product, ...card } : product,
        variants: priced.skus,
        fromMinor: card ? card.priceMinor - Number(card.discountAmountMinor ?? 0) : buyerFromMinor ?? null,
    };
}
