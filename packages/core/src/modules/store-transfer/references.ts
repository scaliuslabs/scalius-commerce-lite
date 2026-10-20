// Brands, categories and specification attributes an import names, found by
// name (case-insensitive, live records only) or created once per name.
//
// Categories follow the file's path from the top of the tree down: each level
// is the live child of the level above with that name, so "Men > Shirts" and
// "Women > Shirts" are two categories. New brands and categories are created
// published, as they were public in the store the merchant is leaving.
// Attributes a file names that do not exist yet are created as text specs.
// A dry run only reports what would be created.

import type { Database } from "@scalius/database/client";
import { brands, categories, productAttributes } from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "@scalius/core/errors";
import { createBrand, createBrandSchema } from "../brands";
import { createCategory, createCategorySchema } from "../categories";
import { createAttribute } from "../attributes";

const key = (value: string) => value.normalize("NFC").trim().toLocaleLowerCase("en-US");

export interface ReferencePlan {
  brandsToCreate: string[];
  categoriesToCreate: string[];
  attributesToCreate: string[];
}

/** Which records the importing staff member may create along the way (their RBAC permissions). */
export interface ReferenceCreationRights {
  brands: boolean;
  categories: boolean;
  attributes: boolean;
}

export const ALL_REFERENCE_RIGHTS: ReferenceCreationRights = { brands: true, categories: true, attributes: true };

function refuse(kind: string, name: string, permission: string): never {
  throw new AppError(403, "forbidden", `Creating the ${kind} "${name}" needs the ${permission} permission. Create it first or ask an owner to import.`);
}

export class ImportReferenceResolver {
  private readonly brandIds = new Map<string, string | null>();
  private readonly categoryIds = new Map<string, string | null>();
  private readonly attributeIds = new Map<string, string | null>();
  readonly plan: ReferencePlan = { brandsToCreate: [], categoriesToCreate: [], attributesToCreate: [] };

  constructor(
    private readonly db: Database,
    private readonly dryRun: boolean,
    private readonly rights: ReferenceCreationRights = ALL_REFERENCE_RIGHTS,
  ) {}

  /** The live brand with this name, created (published) when missing. Null in a dry run when it would be created. */
  async brand(name: string | null): Promise<string | null> {
    if (!name) return null;
    const cacheKey = key(name);
    if (this.brandIds.has(cacheKey)) return this.brandIds.get(cacheKey)!;
    const existing = await this.db.select({ id: brands.id }).from(brands)
      .where(and(sql`lower(trim(${brands.name})) = ${cacheKey}`, isNull(brands.deletedAt)))
      .orderBy(brands.createdAt)
      .get();
    let id = existing?.id ?? null;
    if (!id) {
      if (!this.rights.brands) refuse("brand", name.trim(), "categories.create");
      if (this.dryRun) {
        this.plan.brandsToCreate.push(name.trim());
      } else {
        id = (await createBrand(this.db, createBrandSchema.parse({ name: name.trim(), status: "published" }))).id;
      }
    }
    this.brandIds.set(cacheKey, id);
    return id;
  }

  /** The category at the end of `path` (top level first), creating missing levels. */
  async category(path: readonly string[]): Promise<string | null> {
    let parentId: string | null = null;
    let wouldCreate = false;
    for (let depth = 0; depth < path.length; depth += 1) {
      const name = path[depth]!.trim();
      const cacheKey = path.slice(0, depth + 1).map(key).join("\u0000");
      if (this.categoryIds.has(cacheKey)) {
        parentId = this.categoryIds.get(cacheKey)!;
        wouldCreate = parentId === null;
        continue;
      }
      let id: string | null = null;
      if (!wouldCreate) {
        const existing = await this.db.select({ id: categories.id }).from(categories)
          .where(and(
            sql`lower(trim(${categories.name})) = ${key(name)}`,
            parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId),
            isNull(categories.deletedAt),
          ))
          .orderBy(categories.createdAt)
          .get();
        id = existing?.id ?? null;
      }
      if (!id) {
        if (!this.rights.categories) refuse("category", path.slice(0, depth + 1).join(" > "), "categories.create");
        if (this.dryRun) {
          this.plan.categoriesToCreate.push(path.slice(0, depth + 1).join(" > "));
          wouldCreate = true;
        } else {
          id = (await createCategory(this.db, createCategorySchema.parse({
            name,
            description: null,
            metaTitle: null,
            metaDescription: null,
            image: null,
            status: "published",
            parentId,
          }))).id;
        }
      }
      this.categoryIds.set(cacheKey, id);
      parentId = id;
    }
    return parentId;
  }

  /** Attribute ids by name; missing ones are created as text attributes. */
  async attribute(name: string): Promise<string | null> {
    const cacheKey = key(name);
    if (this.attributeIds.has(cacheKey)) return this.attributeIds.get(cacheKey)!;
    const existing = await this.db.select({ id: productAttributes.id }).from(productAttributes)
      .where(and(sql`lower(trim(${productAttributes.name})) = ${cacheKey}`, isNull(productAttributes.deletedAt)))
      .get();
    let id = existing?.id ?? null;
    if (!id) {
      if (!this.rights.attributes) refuse("specification", name.trim(), "attributes.create");
      if (this.dryRun) {
        this.plan.attributesToCreate.push(name.trim());
      } else {
        id = (await createAttribute(this.db, { name: name.trim(), valueType: "text", filterable: true })).attribute.id;
      }
    }
    this.attributeIds.set(cacheKey, id);
    return id;
  }
}
