import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    type AnySQLiteColumn,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export const mediaFolders = sqliteTable("media_folders", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("media_folders_name_valid", sql`${table.name} = trim(${table.name}) AND ${table.name} <> '' AND length(${table.name}) <= 100`),
    check("media_folders_version_positive", sql`${table.version} >= 1`),
    uniqueIndex("media_folders_active_name_uidx")
        .on(sql`lower(trim(${table.name}))`)
        .where(sql`${table.deletedAt} IS NULL`),
    index("media_folders_active_name_idx").on(table.deletedAt, table.name, table.id),
]);

export const media = sqliteTable("media", {
    id: text("id").primaryKey(),
    filename: text("filename").notNull(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    objectKey: text("object_key").notNull().unique(),
    size: integer("size").notNull(),
    mimeType: text("mime_type").notNull(),
    altText: text("alt_text"),
    caption: text("caption"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    posterMediaId: text("poster_media_id").references((): AnySQLiteColumn => media.id, { onDelete: "set null" }),
    folderId: text("folder_id").references(() => mediaFolders.id, { onDelete: "set null" }),
    status: text("status", { enum: ["ready", "trashed", "deleting", "deleted"] }).notNull().default("ready"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    trashedAt: integer("trashed_at", { mode: "timestamp" }),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    check("media_filename_valid", sql`${table.filename} = trim(${table.filename}) AND ${table.filename} <> '' AND length(${table.filename}) <= 255`),
    check("media_kind_valid", sql`${table.kind} IN ('image', 'video')`),
    check("media_kind_mime_coherent", sql`(
        (${table.kind} = 'image' AND ${table.mimeType} IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'))
        OR (${table.kind} = 'video' AND ${table.mimeType} IN ('video/mp4', 'video/webm'))
    )`),
    check("media_object_key_valid", sql`trim(${table.objectKey}) <> '' AND length(${table.objectKey}) <= 512`),
    check("media_size_positive", sql`${table.size} > 0`),
    check("media_dimensions_positive", sql`(${table.width} IS NULL OR ${table.width} > 0) AND (${table.height} IS NULL OR ${table.height} > 0)`),
    check("media_duration_positive", sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`),
    check("media_status_valid", sql`${table.status} IN ('ready', 'trashed', 'deleting', 'deleted')`),
    check("media_lifecycle_timestamps_valid", sql`(
        (${table.status} = 'ready' AND ${table.trashedAt} IS NULL AND ${table.deletedAt} IS NULL)
        OR (${table.status} IN ('trashed', 'deleting') AND ${table.trashedAt} IS NOT NULL AND ${table.deletedAt} IS NULL)
        OR (${table.status} = 'deleted' AND ${table.trashedAt} IS NOT NULL AND ${table.deletedAt} IS NOT NULL)
    )`),
    check("media_version_positive", sql`${table.version} >= 1`),
    index("media_folder_id_idx").on(table.folderId, table.status, table.createdAt, table.id),
    index("media_status_newest_idx").on(table.status, table.createdAt, table.id),
    index("media_kind_newest_idx").on(table.kind, table.status, table.createdAt, table.id),
    index("media_poster_id_idx").on(table.posterMediaId),
]);

export const mediaUploadSessions = sqliteTable("media_upload_sessions", {
    id: text("id").primaryKey(),
    mediaId: text("media_id").notNull().unique(),
    objectKey: text("object_key").notNull().unique(),
    uploadId: text("upload_id").unique(),
    filename: text("filename").notNull(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    expectedParts: integer("expected_parts").notNull(),
    folderId: text("folder_id").references(() => mediaFolders.id, { onDelete: "set null" }),
    state: text("state", { enum: ["initializing", "initiated", "uploading", "completing", "committed", "aborting", "aborted", "expired", "failed"] }).notNull().default("initializing"),
    version: integer("version").notNull().default(1),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    r2CompletedAt: integer("r2_completed_at", { mode: "timestamp" }),
    committedAt: integer("committed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    check("media_upload_filename_valid", sql`${table.filename} = trim(${table.filename}) AND ${table.filename} <> '' AND length(${table.filename}) <= 255`),
    check("media_upload_kind_valid", sql`${table.kind} IN ('image', 'video')`),
    check("media_upload_kind_mime_coherent", sql`(
        (${table.kind} = 'image' AND ${table.mimeType} IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'))
        OR (${table.kind} = 'video' AND ${table.mimeType} IN ('video/mp4', 'video/webm'))
    )`),
    check("media_upload_size_positive", sql`${table.size} > 0`),
    check("media_upload_expected_parts_valid", sql`${table.expectedParts} >= 1 AND ${table.expectedParts} <= 20`),
    check("media_upload_state_valid", sql`${table.state} IN ('initializing', 'initiated', 'uploading', 'completing', 'committed', 'aborting', 'aborted', 'expired', 'failed')`),
    check("media_upload_handle_valid", sql`(
        (${table.state} IN ('initializing', 'failed') AND ${table.uploadId} IS NULL)
        OR (${table.state} NOT IN ('initializing', 'failed') AND ${table.uploadId} IS NOT NULL)
        OR (${table.state} = 'failed' AND ${table.uploadId} IS NOT NULL)
    )`),
    check("media_upload_completion_timestamps_valid", sql`(
        (${table.state} = 'committed' AND ${table.r2CompletedAt} IS NOT NULL AND ${table.committedAt} IS NOT NULL)
        OR (${table.state} <> 'committed' AND ${table.committedAt} IS NULL)
    )`),
    check("media_upload_version_positive", sql`${table.version} >= 1`),
    index("media_upload_state_expiry_idx").on(table.state, table.expiresAt, table.id),
    index("media_upload_created_idx").on(table.createdAt, table.id),
]);

export const mediaUploadParts = sqliteTable("media_upload_parts", {
    sessionId: text("session_id").notNull().references(() => mediaUploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    etag: text("etag").notNull(),
    size: integer("size").notNull(),
    signatureVerified: integer("signature_verified", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.sessionId, table.partNumber] }),
    check("media_upload_part_number_valid", sql`${table.partNumber} >= 1 AND ${table.partNumber} <= 20`),
    check("media_upload_part_size_valid", sql`${table.size} >= 1 AND ${table.size} <= 5242880`),
    check("media_upload_part_etag_valid", sql`${table.etag} <> '' AND length(${table.etag}) <= 256`),
    index("media_upload_parts_session_idx").on(table.sessionId, table.partNumber),
]);

export type Media = InferSelectModel<typeof media>;
export type MediaFolder = InferSelectModel<typeof mediaFolders>;
export type MediaUploadSession = InferSelectModel<typeof mediaUploadSessions>;
export type MediaUploadPart = InferSelectModel<typeof mediaUploadParts>;
