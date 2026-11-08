// Buyer uploads (migration 0201): a file a buyer gave an app's `file` line
// input or checkout attribute, stored privately in R2 under
// `private/buyer-uploads/<id>` and only ever streamed through a signed API
// link (`@scalius/shared/buyer-uploads`). A row is bound, for good, to its
// app, its input and (a line input) the product it was answered on; the order
// commit attaches it to one order once. Unattached rows are swept after 72
// hours, attached ones a year after their order (order retention), and
// customer erasure deletes those of the customer's orders.
//
// Admin uploads (migration 0207) share the table: a file staff gave one of
// an app's admin forms (`file-field`, target `admin`, CSV text). It is bound
// to its app and the admin route (`<app id>.<route>`), never attached to an
// order, read only by its app (`ctx.uploads`) and deleted by the app or by
// the same 72-hour sweep.
//
// Triggers (migration 0201, recreated by 0207's rebuild):
// buyer_uploads_identity_guard refuses any change of what the upload is and
// any second attach; an attach names a line of the same order for a line
// input and none for an attribute.
import { sql, type InferSelectModel } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { UNIX_NOW } from "./shared";

export const BUYER_UPLOAD_TARGETS = ["line", "attribute", "admin"] as const;

export const buyerUploads = sqliteTable("buyer_uploads", {
    /** `bup_` + 24 random URL-safe characters: the buyer's handle on the upload. */
    id: text("id").primaryKey(),
    /** The app whose input it answers; only this app reads it back. */
    appId: text("app_id").notNull(),
    /** The input, `<app id>.<key>`. */
    fieldKey: text("field_key").notNull(),
    /** `line` (a line input), `attribute` (a checkout attribute) or `admin` (an app's admin form). */
    target: text("target", { enum: BUYER_UPLOAD_TARGETS }).notNull(),
    /** A line input's product (no foreign key: a trashed product keeps its orders' files). */
    productId: text("product_id"),
    /** `private/buyer-uploads/<id>`: never served publicly. */
    r2Key: text("r2_key").notNull(),
    /** Sniffed from the bytes. */
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Display name, cleaned, with the sniffed type's extension. */
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    /** A keyed hash of the uploading visitor (IP) or staff member (admin), for the staged cap; never the address. */
    uploaderKey: text("uploader_key").notNull(),
    orderId: text("order_id"),
    orderItemId: text("order_item_id"),
    attachedAt: integer("attached_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("buyer_uploads_orphan_idx").on(table.createdAt).where(sql`${table.orderId} IS NULL`),
    index("buyer_uploads_uploader_idx").on(table.uploaderKey, table.createdAt).where(sql`${table.orderId} IS NULL`),
    index("buyer_uploads_order_idx").on(table.orderId, table.id).where(sql`${table.orderId} IS NOT NULL`),
    index("buyer_uploads_retention_idx").on(table.attachedAt).where(sql`${table.attachedAt} IS NOT NULL`),
    check("buyer_uploads_id_shape", sql`substr(${table.id}, 1, 4) = 'bup_' AND length(${table.id}) = 28`),
    check("buyer_uploads_app_shape", sql`length(${table.appId}) BETWEEN 3 AND 100 AND substr(${table.fieldKey}, 1, length(${table.appId}) + 1) = ${table.appId} || '.' AND length(${table.fieldKey}) <= 160`),
    check("buyer_uploads_target_check", sql`${table.target} IN ('line', 'attribute', 'admin')`),
    check("buyer_uploads_target_product", sql`(${table.target} = 'line' AND ${table.productId} IS NOT NULL) OR (${table.target} IN ('attribute', 'admin') AND ${table.productId} IS NULL)`),
    check("buyer_uploads_r2_key_private", sql`${table.r2Key} = 'private/buyer-uploads/' || ${table.id}`),
    check("buyer_uploads_media_type_check", sql`${table.mediaType} IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv')`),
    check("buyer_uploads_size_bounds", sql`${table.sizeBytes} BETWEEN 1 AND 20971520`),
    check("buyer_uploads_filename_length", sql`length(${table.filename}) BETWEEN 1 AND 120`),
    check("buyer_uploads_sha256_shape", sql`length(${table.sha256}) = 64`),
    check("buyer_uploads_uploader_key_shape", sql`length(${table.uploaderKey}) = 64`),
    check("buyer_uploads_attach_shape", sql`(${table.orderId} IS NULL AND ${table.orderItemId} IS NULL AND ${table.attachedAt} IS NULL) OR (${table.orderId} IS NOT NULL AND ${table.attachedAt} IS NOT NULL AND ${table.target} <> 'admin' AND (${table.target} = 'line') = (${table.orderItemId} IS NOT NULL))`),
]);

export type BuyerUpload = InferSelectModel<typeof buyerUploads>;
