---
name: scalius-catalog
description: "Operate Scalius Commerce catalog: products, configurable variants/SKUs, categories, attributes, media imports/uploads, inventory/stock alerts, pricing, catalog SEO, product feeds, sitemap inclusion, and buyer availability. Use to create, edit, publish, trash, restore, or verify resources; build option matrices; assign images; change stock; or diagnose feed, SKU, image, price, and availability truth."
---

# Scalius Catalog

Treat live workflow and operation contracts as authority. Never invent IDs, revisions, fields, defaults, combinations, prices, stock, or claims.

## Route the task

1. For a supported natural-language data read, start with MCP `workflows.read`; otherwise use `workflows.resolve`. CLI parity is `scalius workflow read "<request>" --surface dashboard|storefront` or `scalius workflow resolve ...`.
2. Follow returned facts, phases, stop rules, confirmation, and bounded verification. Describe only selected operation IDs when exact input schema is needed.
3. Never use the removed MCP operation-search tool, inspect repository/source/generated contracts, or bypass an unavailable grant.
4. Resolve names to live IDs and revisions. Ask for missing facts; do not infer them. Confirm a concrete mutation before execution.

## Construct an optioned product

1. Resolve or create category/attribute IDs. Use category revisions; keep a new category draft until an active product has a buyer-resolvable SKU. Assign merchant values by attribute ID.
2. Commit images first. Retain `media_*` IDs and make caller-local `pmed_*` associations. Variant `imageId` points to its `pmed_*`, never `media_*`; `null` deliberately falls back to the primary image.
3. Define axes and values in merchant order. Make every SKU select one value per axis in that order, materialize the complete Cartesian matrix, and preserve each supplied SKU, price, stock, barcode, and image row. Normalized SKU/barcode identities are globally unique.
4. Treat products as containers: inventory belongs to persisted variants. A simple product has one hidden/default SKU; an optioned product has no product-level stock.
5. Submit description, attributes, media, ordered options, full matrix, category, status, and discovery in one atomic create. Do not create variants afterward. If its non-idempotent response is uncertain, reread by identity before retrying.

## Verify truth and media

- Read bounded admin base, media, attribute, option, and paged variant sections; never total a partial page.
- Read the storefront product and check every SKU's price, variant-image precedence, and availability band. Never expose dashboard stock as buyer exact quantity.
- When requested, verify canonical path plus sitemap/feed rows. Feed availability comes from buyer-resolvable SKUs, not product status; never fabricate brand, condition, taxonomy, image, or positive price.
- Use public HTTPS import from remote MCP. Remote MCP cannot read local paths; use a capable local client's reviewed upload flow. Never embed large base64 or invent direct HTTP/upload steps.
