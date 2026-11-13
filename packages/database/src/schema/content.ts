// src/db/schema/content.ts
// Site content tables: CMS pages and articles. The homepage hero lives in the
// storefront theme document.

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { UNIX_NOW } from "./shared";

export type PageFeaturedImage = {
  id: string;
  url: string;
  filename: string;
  size: number;
  mimeType?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
};

export const CONTENT_ENTRY_TYPES = ["page", "article"] as const;
export type ContentEntryType = (typeof CONTENT_ENTRY_TYPES)[number];

export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    contentType: text("content_type", { enum: CONTENT_ENTRY_TYPES })
      .notNull()
      .default("page"),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    content: text("content").notNull(),
    /**
     * The content's search text (`richTextSearchText`), written with the content
     * by the write path; NULL until the scheduled backfill fills a row written
     * otherwise (search then reads the raw content). Never shown to buyers.
     */
    contentSearchText: text("content_search_text"),
    /**
     * The search text's revision: a write path that writes the content moves it
     * in the same statement, so the `*_stale` trigger tells a write that
     * supplied the search text (even the same text) from SQL that did not.
     * Below zero only while the search text is NULL: -1 the raw content indexes
     * as its own search text, -2 its search text could not be computed
     * (both leave the backfill; the next raw change resets it to 0).
     */
    contentSearchRev: integer("content_search_rev").notNull().default(0),
    excerpt: text("excerpt"),
    author: text("author"),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    canonicalPath: text("canonical_path"),
    noIndex: integer("no_index", { mode: "boolean" }).notNull().default(false),
    excludeFromSitemap: integer("exclude_from_sitemap", { mode: "boolean" })
      .notNull()
      .default(false),
    isPublished: integer("is_published", { mode: "boolean" })
      .notNull()
      .default(true),
    hideHeader: integer("hide_header", { mode: "boolean" })
      .notNull()
      .default(false),
    hideFooter: integer("hide_footer", { mode: "boolean" })
      .notNull()
      .default(false),
    hideTitle: integer("hide_title", { mode: "boolean" })
      .notNull()
      .default(false),
    featuredImage: text("featured_image", {
      mode: "json",
    }).$type<PageFeaturedImage | null>(),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    sortOrder: integer("sort_order").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("pages_slug_idx").on(table.slug),
    // The search-text backfill's queue: rows with no search text yet.
    index("pages_search_text_pending_idx").on(table.id).where(sql`${table.contentSearchText} IS NULL AND ${table.contentSearchRev} >= 0`),
    index("pages_deleted_at_idx").on(table.deletedAt),
    index("pages_content_type_deleted_at_idx").on(
      table.contentType,
      table.deletedAt,
    ),
    index("pages_content_type_published_at_idx").on(
      table.contentType,
      table.isPublished,
      table.publishedAt,
    ),
    check(
      "pages_content_type_valid",
      sql.raw(`"content_type" IN ('page', 'article')`),
    ),
    check(
      "pages_static_fields_valid",
      sql.raw(
        `"content_type" = 'article' OR ("excerpt" IS NULL AND "author" IS NULL AND json_array_length("tags") = 0)`,
      ),
    ),
    check("pages_revision_positive", sql.raw(`"revision" >= 1`)),
  ],
);

export type Page = InferSelectModel<typeof pages>;

/**
 * Old storefront addresses that lead somewhere else (0181): a product's
 * previous URL handle, or one a merchant added. Looked up only when a path
 * answers 404, so a page that exists never pays for it. Paths are
 * store-relative ("/products/old-handle"); `from_path` is unique.
 */
export const urlRedirects = sqliteTable(
  "url_redirects",
  {
    id: text("id").primaryKey(),
    fromPath: text("from_path").notNull(),
    toPath: text("to_path").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
  },
  (table) => [
    uniqueIndex("url_redirects_from_path_unique").on(table.fromPath),
    index("url_redirects_to_path_idx").on(table.toPath),
    check("url_redirects_paths", sql.raw(`substr("from_path", 1, 1) = '/' AND substr("to_path", 1, 1) = '/' AND "from_path" <> "to_path"`)),
  ],
);

export type UrlRedirect = InferSelectModel<typeof urlRedirects>;
