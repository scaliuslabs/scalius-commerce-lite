import { categories, collections, pages, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { NavigationResourceType } from "@scalius/shared/navigation-target";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { ValidationError } from "@scalius/core/errors";
import { ftsMatch } from "../../search";
import { contentEntryPath } from "../pages/pages.validation";
import { publicCategoryConditions } from "../categories/categories.publication";

const DEFAULT_RESOURCE_PAGE_SIZE = 20;
const MAX_RESOURCE_PAGE_SIZE = 100;

export interface NavigationResourceCursor {
  name: string;
  id: string;
}

export interface NavigationResourceOption {
  id: string;
  name: string;
  type: NavigationResourceType;
  url: string;
  available: boolean;
}

export interface NavigationResourcePage {
  items: NavigationResourceOption[];
  selected: NavigationResourceOption | null;
  nextCursor: NavigationResourceCursor | null;
}

export interface ListNavigationResourcesInput {
  type: NavigationResourceType;
  query?: string;
  cursor?: NavigationResourceCursor;
  limit?: number;
  selectedId?: string;
}

function normalizeResourceLimit(value: number | undefined): number {
  if (value == null) return DEFAULT_RESOURCE_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESOURCE_PAGE_SIZE) {
    throw new ValidationError(
      `Navigation resource pages contain between 1 and ${MAX_RESOURCE_PAGE_SIZE} items.`,
    );
  }
  return value;
}

function afterResourceCursor(
  nameColumn: AnySQLiteColumn,
  idColumn: AnySQLiteColumn,
  cursor: NavigationResourceCursor | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    gt(nameColumn, cursor.name),
    and(eq(nameColumn, cursor.name), gt(idColumn, cursor.id)),
  );
}

function pageFromRows(
  rows: NavigationResourceOption[],
  limit: number,
): Pick<NavigationResourcePage, "items" | "nextCursor"> {
  const items = rows.slice(0, limit);
  const last = rows.length > limit ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: last ? { name: last.name, id: last.id } : null,
  };
}

function pageRoute(row: {
  contentType: "page" | "article";
  slug: string;
  canonicalPath: string | null;
}): string {
  return normalizeResourceCanonicalPath(row.contentType, row.canonicalPath)
    ?? contentEntryPath(row.contentType, row.slug);
}

async function listReadyResources(
  db: Database,
  input: ListNavigationResourcesInput,
  limit: number,
): Promise<Pick<NavigationResourcePage, "items" | "nextCursor">> {
  const query = input.query?.trim().slice(0, 100) ?? "";
  const rowLimit = limit + 1;

  if (input.type === "category") {
    const rows = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        canonicalPath: categories.canonicalPath,
      })
      .from(categories)
      .where(and(
        ...publicCategoryConditions(),
        afterResourceCursor(categories.name, categories.id, input.cursor),
        query ? ftsMatch("categories_fts", "categories", query) : undefined,
      ))
      .orderBy(asc(categories.name), asc(categories.id))
      .limit(rowLimit);
    return pageFromRows(rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: "category",
      url: normalizeResourceCanonicalPath("category", row.canonicalPath)
        ?? `/categories/${row.slug}`,
      available: true,
    })), limit);
  }

  if (input.type === "page") {
    const rows = await db
      .select({
        id: pages.id,
        name: pages.title,
        slug: pages.slug,
        contentType: pages.contentType,
        canonicalPath: pages.canonicalPath,
      })
      .from(pages)
      .where(and(
        isNull(pages.deletedAt),
        eq(pages.isPublished, true),
        afterResourceCursor(pages.title, pages.id, input.cursor),
        query ? ftsMatch("pages_fts", "pages", query) : undefined,
      ))
      .orderBy(asc(pages.title), asc(pages.id))
      .limit(rowLimit);
    return pageFromRows(rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: "page",
      url: pageRoute(row),
      available: true,
    })), limit);
  }

  if (input.type === "product") {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        slug: products.slug,
        canonicalPath: products.canonicalPath,
      })
      .from(products)
      .where(and(
        isNull(products.deletedAt),
        eq(products.isActive, true),
        afterResourceCursor(products.name, products.id, input.cursor),
        query ? ftsMatch("products_fts", "products", query) : undefined,
      ))
      .orderBy(asc(products.name), asc(products.id))
      .limit(rowLimit);
    return pageFromRows(rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: "product",
      url: normalizeResourceCanonicalPath("product", row.canonicalPath)
        ?? `/products/${row.slug}`,
      available: true,
    })), limit);
  }

  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      canonicalPath: collections.canonicalPath,
    })
    .from(collections)
    .where(and(
      isNull(collections.deletedAt),
      eq(collections.isActive, true),
      afterResourceCursor(collections.name, collections.id, input.cursor),
      query
        ? sql`instr(lower(${collections.name}), lower(${query})) > 0`
        : undefined,
    ))
    .orderBy(asc(collections.name), asc(collections.id))
    .limit(rowLimit);
  return pageFromRows(rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: "collection",
    url: normalizeResourceCanonicalPath("collection", row.canonicalPath)
      ?? `/collections/${row.id}`,
    available: true,
  })), limit);
}

async function getNavigationResourceById(
  db: Database,
  type: NavigationResourceType,
  id: string,
): Promise<NavigationResourceOption | null> {
  if (type === "category") {
    const [row] = await db.select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      canonicalPath: categories.canonicalPath,
      status: categories.status,
      deletedAt: categories.deletedAt,
    }).from(categories).where(eq(categories.id, id)).limit(1);
    return row ? {
      id: row.id,
      name: row.name,
      type,
      url: normalizeResourceCanonicalPath("category", row.canonicalPath)
        ?? `/categories/${row.slug}`,
      available: !row.deletedAt && row.status === "published",
    } : null;
  }

  if (type === "page") {
    const [row] = await db.select({
      id: pages.id,
      name: pages.title,
      slug: pages.slug,
      contentType: pages.contentType,
      canonicalPath: pages.canonicalPath,
      isPublished: pages.isPublished,
      deletedAt: pages.deletedAt,
    }).from(pages).where(eq(pages.id, id)).limit(1);
    return row ? {
      id: row.id,
      name: row.name,
      type,
      url: pageRoute(row),
      available: !row.deletedAt && row.isPublished,
    } : null;
  }

  if (type === "product") {
    const [row] = await db.select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      canonicalPath: products.canonicalPath,
      isActive: products.isActive,
      deletedAt: products.deletedAt,
    }).from(products).where(eq(products.id, id)).limit(1);
    return row ? {
      id: row.id,
      name: row.name,
      type,
      url: normalizeResourceCanonicalPath("product", row.canonicalPath)
        ?? `/products/${row.slug}`,
      available: !row.deletedAt && row.isActive,
    } : null;
  }

  const [row] = await db.select({
    id: collections.id,
    name: collections.name,
    canonicalPath: collections.canonicalPath,
    isActive: collections.isActive,
    deletedAt: collections.deletedAt,
  }).from(collections).where(eq(collections.id, id)).limit(1);
  return row ? {
    id: row.id,
    name: row.name,
    type,
    url: normalizeResourceCanonicalPath("collection", row.canonicalPath)
      ?? `/collections/${row.id}`,
    available: !row.deletedAt && row.isActive,
  } : null;
}

export async function listNavigationResources(
  db: Database,
  input: ListNavigationResourcesInput,
): Promise<NavigationResourcePage> {
  const limit = normalizeResourceLimit(input.limit);
  const page = await listReadyResources(db, input, limit);
  const selectedFromPage = input.selectedId
    ? page.items.find((item) => item.id === input.selectedId) ?? null
    : null;
  const selected = selectedFromPage ?? (
    input.selectedId
      ? await getNavigationResourceById(db, input.type, input.selectedId)
      : null
  );

  return { ...page, selected };
}
