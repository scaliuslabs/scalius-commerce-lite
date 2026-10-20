---
name: scalius-catalog
description: Manage the Scalius catalog. Use to create or edit products (simple or with options such as size and color), SKUs and prices, stock counts, adjustments and transfers between locations, product photos, categories, collections, SEO fields, product feeds and barcode labels, including bulk price or stock changes.
license: AGPL-3.0-only
---

# Scalius Catalog

Follow the loop in `scalius`: search, describe, read facts, dry run, approval when asked, write, verify. Step-by-step recipes: [references/recipes.md](references/recipes.md). Reviewed workflows: [references/workflows.md](references/workflows.md).

## How products work

- A product is a container; what sells and holds stock is a SKU (`product_variants`). A simple product has exactly one hidden SKU (`defaultSku` on create). There is no product-level stock.
- Options are merchant-named axes, at most five. Every active SKU picks exactly one value of every axis, in axis order. Create the whole matrix in one `dashboard.products.create`; do not add SKUs afterwards one by one. If a create's answer is lost, read by name before retrying.
- SKU codes and barcodes are unique across the store, ignoring case and spaces.
- Prices use the store currency (`dashboard.settings.currency_get`); never convert. Ask for any price, stock, option value or copy the merchant did not give.
- Product edits send the `aggregateRevision` from a fresh `dashboard.products.get_section`; on a conflict, reread and reapply only the requested change.

## Media

- In a shell: `scalius media upload <files...> --yes` checks, uploads and returns media ids. Without one, `dashboard.media.import_url` takes a public HTTPS link. Never paste base64.
- A SKU's `imageId` points at one of the product's own images; `null` means the primary image.

## Stock

- Count (stocktake): `dashboard.inventory.set_stock`. Change by an amount: `dashboard.inventory.adjust_stock`. Between locations: a transfer (create, ship, receive). Each takes an idempotency key; the tools add one.
- Buyers see an availability band, never the exact count.

## Bulk

Many SKUs at once: `scalius bulk prices --filter 'category=<id>' --percent 5 --dry-run` (or `--set 1500` for a fixed price, `--amount -100` to take 100 off; amounts are in the store currency, so `1500` is 1,500.00 BDT in a taka store, and `--minor` says they are minor units) and `scalius bulk stock --items var_1=20,var_2=0 --dry-run` show before and after for the first 50 and name the currency. The merchant approves the table, then run the same command with `--yes`. Up to 250 items finish at once; larger runs continue on the server and `--wait` follows them (`data.id` is the run). Same shapes for `bulk status` and `bulk publish`.

## Feeds and SEO

Feed rows come from buyer-sellable SKUs with a real image and a positive price. `noIndex` hides a product from search engines but keeps its page; `excludeFromSitemap` only leaves it out of the sitemap. Never invent a brand, condition or category mapping.
