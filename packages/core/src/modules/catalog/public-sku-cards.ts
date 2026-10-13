// Exact buyer SKU cards for private surfaces (Inbox and shared carts). The API
// composes this read with conversations; neither domain imports the other.
import type { Database } from "@scalius/database/client";
import { products, productVariants, productOptionDefinitions, productOptionValues, productVariantOptionValues } from "@scalius/database/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { discountedPriceMinor } from "@scalius/shared/money";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import { presencePath } from "@scalius/shared/markets";
import { channelOnHandSql, operationalSkuRowPredicate, publicProductBaseConditions, resolveProductMediaProjectionRows, resolveSkuImageRepresentation, selectCheckoutProductMediaProjectionRows } from "../products";
import { storeCurrencyFromSql, storePriceIncrementSql } from "../markets";
import { storeCurrencyCodeSql } from "../settings";
import { isNeutralMarketPricing, marketListPricesSql, marketPriceContextOf, priceProductSkus, type MarketPricing } from "../price-lists";
import { applyTranslation, foldedTranslationChain, localizedSlugSql, translationRowsSql, translationScopeOf } from "../translations";

export interface PublicSkuCardRef { productId: string; skuId: string }
export interface PublicSkuCard extends PublicSkuCardRef {
  title: string;
  variantLabel: string | null;
  priceMinor: number;
  currencyCode: string;
  availableForSale: boolean;
  imageUrl: string | null;
  /** Same-store path, including the market presence and exact SKU. */
  pdpUrl: string;
}

/** Missing, private and retired identities are omitted; input order is retained. */
export async function getPublicSkuCards(
  db: Database,
  refs: readonly PublicSkuCardRef[],
  pricing: MarketPricing | null = null,
): Promise<PublicSkuCard[]> {
  if (refs.length > 90) throw new ValidationError("Request at most 90 product cards at once.");
  if (refs.length === 0) return [];
  const translation = translationScopeOf(pricing);
  const skuIds = JSON.stringify([...new Set(refs.map((ref) => ref.skuId))]);
  const rows = await db.select({
    id: productVariants.id,
    productId: productVariants.productId,
    title: products.name,
    slug: products.slug,
    productPriceMinor: sql<number>`${products.priceMinor}`.as("card_product_price_minor"),
    productDiscountType: sql<string | null>`${products.discountType}`.as("card_product_discount_type"),
    productDiscountBps: sql<number>`${products.discountBps}`.as("card_product_discount_bps"),
    productDiscountAmountMinor: sql<number>`${products.discountAmountMinor}`.as("card_product_discount_amount"),
    priceMinor: productVariants.priceMinor,
    discountType: productVariants.discountType,
    discountBps: productVariants.discountBps,
    discountAmountMinor: productVariants.discountAmountMinor,
    stock: channelOnHandSql({ id: sql`${productVariants.id}`, stock: sql`${productVariants.stock}` }).mapWith(Number),
    reservedStock: productVariants.reservedStock,
    trackInventory: productVariants.trackInventory,
    isDefault: productVariants.isDefault,
    optionCombinationKey: productVariants.optionCombinationKey,
    imageId: productVariants.imageId,
    currencyCode: storeCurrencyCodeSql(),
    priceIncrementMinor: storePriceIncrementSql(),
    ...(pricing ? { listPrices: marketListPricesSql(sql.raw('"product_variants"."id"'), { presence: pricing.presence }) } : {}),
    ...(translation ? {
      trRows: translationRowsSql(translation, "product", products.id),
      trSlug: localizedSlugSql(translation, "product", products.id),
    } : {}),
  }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(
      sql`${productVariants.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${skuIds}))`,
      isNull(productVariants.deletedAt),
      sql`${productVariants.id} <> 'default'`,
      operationalSkuRowPredicate(),
      ...publicProductBaseConditions(),
    )).all();
  const expected = new Set(refs.map((ref) => `${ref.productId}\0${ref.skuId}`));
  const valid = rows.filter((row) => expected.has(`${row.productId}\0${row.id}`));
  if (valid.length === 0) return [];
  const ids = JSON.stringify(valid.map((row) => row.id));
  const [mediaRows, options, context] = await Promise.all([
    selectCheckoutProductMediaProjectionRows(db, valid.map((row) => row.productId), valid.map((row) => row.id)),
    db.select({
      skuId: productVariantOptionValues.variantId,
      name: productOptionDefinitions.name,
      value: productOptionValues.value,
      ...(translation ? {
        nameTranslations: translationRowsSql(translation, "product_option", productOptionDefinitions.id),
        valueTranslations: translationRowsSql(translation, "product_option_value", productOptionValues.id),
      } : {}),
    }).from(productVariantOptionValues)
      .innerJoin(productOptionDefinitions, eq(productOptionDefinitions.id, productVariantOptionValues.optionDefinitionId))
      .innerJoin(productOptionValues, and(eq(productOptionValues.id, productVariantOptionValues.optionValueId), eq(productOptionValues.optionDefinitionId, productOptionDefinitions.id)))
      .where(and(
        sql`${productVariantOptionValues.variantId} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`,
        isNull(productOptionDefinitions.deletedAt), isNull(productOptionValues.deletedAt),
      )).orderBy(asc(productVariantOptionValues.variantId), asc(productOptionDefinitions.position)).all(),
    marketPriceContextOf(pricing),
  ]);
  const labels = new Map<string, string[]>();
  for (const option of options) {
    const named = translation
      ? applyTranslation(option, foldedTranslationChain(translation, option.nameTranslations), { name: "name" })
      : option;
    const translated = translation
      ? applyTranslation(named, foldedTranslationChain(translation, option.valueTranslations), { value: "value" })
      : named;
    const selected = labels.get(option.skuId) ?? [];
    selected.push(`${translated.name}: ${translated.value}`);
    labels.set(option.skuId, selected);
  }
  const media = resolveProductMediaProjectionRows(mediaRows);
  const shop = storeCurrencyFromSql(valid[0]!.currencyCode, valid[0]!.priceIncrementMinor);
  const productDiscounts = new Map(valid.map((row) => [row.productId, {
    priceMinor: row.productPriceMinor,
    discountType: row.productDiscountType,
    discountBps: row.productDiscountBps,
    discountAmountMinor: row.productDiscountAmountMinor,
  }]));
  const priced = priceProductSkus(context, productDiscounts, valid, shop.priceIncrementMinor).skus;
  const cards = new Map<string, PublicSkuCard>();
  for (const row of priced) {
    const translated = translation
      ? applyTranslation(row, foldedTranslationChain(translation, row.trRows), { title: "name" }, row.trSlug ?? null)
      : row;
    const ownDiscount = (row.discountType === "percentage" && row.discountBps > 0)
      || (row.discountType === "flat" && row.discountAmountMinor > 0);
    const discount = !isNeutralMarketPricing(context) || ownDiscount ? row : productDiscounts.get(row.productId)!;
    // An action uses this product's real localized handle. SEO canonicals may
    // consolidate onto another product or a different language's handle.
    const path = `/products/${encodeURIComponent(translated.slug)}`;
    const image = resolveSkuImageRepresentation(media.get(row.productId) ?? [], row.imageId);
    cards.set(row.id, {
      productId: row.productId, skuId: row.id,
      title: translated.title,
      variantLabel: row.isDefault ? null : labels.get(row.id)?.join(" · ") || null,
      priceMinor: discountedPriceMinor(row.priceMinor, discount.discountType, discount.discountBps, discount.discountAmountMinor, context?.incrementMinor ?? shop.priceIncrementMinor),
      currencyCode: context?.currencyCode ?? shop.code,
      availableForSale: !row.trackInventory || row.stock - row.reservedStock > 0,
      imageUrl: normalizePublicMediaUrl(image?.url),
      pdpUrl: `${presencePath(pricing?.presence, path)}?variant=${encodeURIComponent(row.id)}`,
    });
  }
  return refs.flatMap((ref) => {
    const card = cards.get(ref.skuId);
    return card && card.productId === ref.productId ? [card] : [];
  });
}
