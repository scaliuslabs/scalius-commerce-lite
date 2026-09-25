// Digital goods (Wave B §3). Files live in private R2 under
// `private/digital/<asset>/<upload>` and are only ever streamed through a
// cookie-bound download ticket. Licence keys are encrypted at rest (keys
// derived from CREDENTIAL_ENCRYPTION_KEY) and pooled per variant; the pool is
// the variant's tracked stock. An entitlement records what an order line
// received; its download count never passes its limit (CHECK + guarded
// UPDATE). Vocabulary and limits live in `@scalius/shared/digital`.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { products, productVariants } from "./products";
import { orders, orderItems } from "./orders";
import { orderFulfillments } from "./fulfilment";

export const digitalAssets = sqliteTable("digital_assets", {
    /** `dga_` + random. */
    id: text("id").primaryKey(),
    productId: text("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "cascade" }),
    /** NULL = every digital variant of the product. */
    variantId: text("variant_id")
        .references(() => productVariants.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["file", "licence_keys"] }).notNull(),
    /** `draft` until a file upload completes; `ready` assets are delivered; `archived` are not. */
    status: text("status", { enum: ["draft", "ready", "archived"] }).notNull().default("draft"),
    displayName: text("display_name").notNull(),
    filename: text("filename"),
    mediaType: text("media_type"),
    sizeBytes: integer("size_bytes"),
    currentR2Key: text("current_r2_key"),
    /** NULL = unlimited. */
    downloadLimit: integer("download_limit").default(5),
    /** NULL = forever. */
    accessDays: integer("access_days"),
    sortOrder: integer("sort_order").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("digital_assets_product_status_idx").on(table.productId, table.status),
    index("digital_assets_variant_status_idx").on(table.variantId, table.status),
    check("digital_assets_id_shape", sql`substr(${table.id}, 1, 4) = 'dga_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("digital_assets_kind_check", sql`${table.kind} IN ('file', 'licence_keys')`),
    check("digital_assets_status_check", sql`${table.status} IN ('draft', 'ready', 'archived')`),
    check("digital_assets_display_name_length", sql`length(trim(${table.displayName})) BETWEEN 1 AND 200`),
    check("digital_assets_file_shape", sql`(${table.kind} = 'file') = (${table.filename} IS NOT NULL AND ${table.mediaType} IS NOT NULL) AND (${table.kind} = 'file' OR (${table.sizeBytes} IS NULL AND ${table.currentR2Key} IS NULL))`),
    check("digital_assets_ready_file", sql`${table.kind} <> 'file' OR ${table.status} <> 'ready' OR (${table.currentR2Key} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL)`),
    check("digital_assets_r2_key_prefix", sql`${table.currentR2Key} IS NULL OR substr(${table.currentR2Key}, 1, 16) = 'private/digital/'`),
    check("digital_assets_size_range", sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} BETWEEN 0 AND 2147483648`),
    check("digital_assets_download_limit_range", sql`${table.downloadLimit} IS NULL OR ${table.downloadLimit} BETWEEN 1 AND 100`),
    check("digital_assets_access_days_range", sql`${table.accessDays} IS NULL OR ${table.accessDays} BETWEEN 1 AND 3650`),
    check("digital_assets_version_positive", sql`${table.version} >= 1`),
]);

export const digitalAssetUploads = sqliteTable("digital_asset_uploads", {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
        .notNull()
        .references(() => digitalAssets.id, { onDelete: "cascade" }),
    /** `private/digital/<asset>/<upload>`. */
    r2Key: text("r2_key").notNull(),
    r2UploadId: text("r2_upload_id").notNull(),
    status: text("status", { enum: ["uploading", "complete", "aborted"] }).notNull().default("uploading"),
    /** JSON array of `{ partNumber, etag }` for the completed parts. */
    parts: text("parts").notNull().default("[]"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("digital_asset_uploads_r2_key_unique").on(table.r2Key),
    index("digital_asset_uploads_asset_idx").on(table.assetId),
    index("digital_asset_uploads_uploading_idx")
        .on(table.status, table.createdAt)
        .where(sql`${table.status} = 'uploading'`),
    check("digital_asset_uploads_status_check", sql`${table.status} IN ('uploading', 'complete', 'aborted')`),
    check("digital_asset_uploads_r2_key_prefix", sql`substr(${table.r2Key}, 1, 16) = 'private/digital/'`),
    check("digital_asset_uploads_parts_json", sql`json_valid(${table.parts}) AND length(${table.parts}) <= 20000`),
]);

export const digitalEntitlements = sqliteTable("digital_entitlements", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id")
        .notNull()
        .references(() => orderItems.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
        .notNull()
        .references(() => digitalAssets.id, { onDelete: "restrict" }),
    fulfillmentId: text("fulfillment_id")
        .references(() => orderFulfillments.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["file", "licence_keys"] }).notNull(),
    /** Keys assigned (licence_keys); 1 for files. */
    quantity: integer("quantity").notNull().default(1),
    downloadCount: integer("download_count").notNull().default(0),
    /** Snapshot of the asset limit at delivery; NULL = unlimited. */
    downloadLimit: integer("download_limit"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    lastDownloadAt: integer("last_download_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("digital_entitlements_item_asset_unique").on(table.orderItemId, table.assetId),
    index("digital_entitlements_order_idx").on(table.orderId),
    index("digital_entitlements_asset_idx").on(table.assetId),
    check("digital_entitlements_kind_check", sql`${table.kind} IN ('file', 'licence_keys')`),
    check("digital_entitlements_quantity_positive", sql`${table.quantity} >= 1`),
    check("digital_entitlements_download_count_bounds", sql`${table.downloadCount} >= 0 AND (${table.downloadLimit} IS NULL OR ${table.downloadCount} <= ${table.downloadLimit})`),
    check("digital_entitlements_download_limit_range", sql`${table.downloadLimit} IS NULL OR ${table.downloadLimit} BETWEEN 1 AND 100`),
]);

export const digitalLicenceKeys = sqliteTable("digital_licence_keys", {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
        .notNull()
        .references(() => digitalAssets.id, { onDelete: "restrict" }),
    keyCiphertext: text("key_ciphertext").notNull(),
    /** HMAC of the normalized key; dedupes imports per pool. */
    keyHash: text("key_hash").notNull(),
    keyLast4: text("key_last4").notNull(),
    status: text("status", { enum: ["available", "assigned", "revoked"] }).notNull().default("available"),
    orderItemId: text("order_item_id")
        .references(() => orderItems.id, { onDelete: "restrict" }),
    entitlementId: text("entitlement_id")
        .references(() => digitalEntitlements.id, { onDelete: "restrict" }),
    importId: text("import_id").notNull(),
    assignedAt: integer("assigned_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("digital_licence_keys_asset_hash_unique").on(table.assetId, table.keyHash),
    index("digital_licence_keys_pool_idx").on(table.assetId, table.status, table.createdAt, table.id),
    index("digital_licence_keys_order_item_idx")
        .on(table.orderItemId)
        .where(sql`${table.orderItemId} IS NOT NULL`),
    check("digital_licence_keys_status_check", sql`${table.status} IN ('available', 'assigned', 'revoked')`),
    check("digital_licence_keys_last4_length", sql`length(${table.keyLast4}) BETWEEN 1 AND 4`),
    check("digital_licence_keys_assignment_shape", sql`(${table.status} = 'assigned') = (${table.orderItemId} IS NOT NULL AND ${table.entitlementId} IS NOT NULL AND ${table.assignedAt} IS NOT NULL)`),
    check("digital_licence_keys_revoked_shape", sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`),
    // Trigger: digital_licence_keys_transition (only available -> assigned|revoked; assignment is final).
]);

export type DigitalAsset = InferSelectModel<typeof digitalAssets>;
export type DigitalAssetUpload = InferSelectModel<typeof digitalAssetUploads>;
export type DigitalEntitlement = InferSelectModel<typeof digitalEntitlements>;
export type DigitalLicenceKey = InferSelectModel<typeof digitalLicenceKeys>;
