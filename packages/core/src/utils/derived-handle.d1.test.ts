import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { categories } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { ConflictError } from "@scalius/core/errors";
import { createAttribute } from "../modules/attributes/attributes.service";
import { createAttributeSchema } from "../modules/attributes/attributes.validation";
import { createCategory } from "../modules/categories/categories.service";
import { createCategorySchema } from "../modules/categories/categories.validation";
import { createPage } from "../modules/pages/pages.service";
import { createPageSchema } from "../modules/pages/pages.validation";
import { createProduct } from "../modules/products/products.admin";
import { createProductSchema } from "../modules/products/products.validation";
import { insertWithDerivedHandle } from "./derived-handle";

vi.mock("../modules/inventory/alerts", () => ({ checkAndAlertLowStock: vi.fn() }));

const categoryFields = { description: null, metaTitle: null, metaDescription: null, image: null };
const productFields = {
  description: null,
  price: 250,
  categoryId: "cat_1",
  isActive: false,
  discountType: "percentage" as const,
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  productCondition: "new" as const,
  media: [],
  attributes: [],
  additionalInfo: [],
};
const pageFields = { content: "<p>Hello</p>", metaTitle: null, metaDescription: null };

describe("handles derived on create", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec("INSERT INTO categories (id, name, slug) VALUES ('cat_1', 'Tees', 'tees');");
  });
  afterEach(() => sqlite.close());

  const slugOf = (table: string, id: string) =>
    (sqlite.prepare(`SELECT slug FROM ${table} WHERE id = ?`).get(id) as { slug: string }).slug;
  const category = (fields: Record<string, unknown>) =>
    createCategory(db, createCategorySchema.parse({ ...categoryFields, ...fields }));
  const product = (fields: Record<string, unknown>) =>
    createProduct(db, createProductSchema.parse({ ...productFields, ...fields }));

  it("gives two categories with the same Bangla name kurta and kurta-2", async () => {
    const first = await category({ name: "কুর্তা" });
    const second = await category({ name: "কুর্তা " });

    expect(slugOf("categories", first.id)).toBe("kurta");
    expect(slugOf("categories", second.id)).toBe("kurta-2");
  });

  it("keeps the Bangla part of a mixed name and suffixes past trashed categories", async () => {
    sqlite.exec(`INSERT INTO categories (id, name, slug, deleted_at)
      VALUES ('cat_old', 'Old', 'r3-cat-kurta-kurta', unixepoch());`);

    const { id } = await category({ name: "R3-CAT Kurta কুর্তা" });

    expect(slugOf("categories", id)).toBe("r3-cat-kurta-kurta-2");
  });

  it("still refuses a typed category handle that is taken", async () => {
    await category({ name: "Kurta" });

    await expect(category({ name: "Another kurta", slug: "kurta" })).rejects.toThrow(
      new ConflictError("A category with this slug already exists."),
    );
  });

  it("gives a name with nothing readable a resource handle", async () => {
    const { id } = await category({ name: "🎉🎉🎉" });

    expect(slugOf("categories", id)).toMatch(/^category-[a-z0-9]{4}$/);
  });

  it("gives two products with the same Bangla name lal-shari and lal-shari-2", async () => {
    const first = await product({ name: "লাল শাড়ি" });
    const second = await product({ name: "লাল শাড়ি" });

    expect(slugOf("products", first.id)).toBe("lal-shari");
    expect(slugOf("products", second.id)).toBe("lal-shari-2");
  });

  it("refuses a typed product handle that is taken, even by a trashed product", async () => {
    const { id } = await product({ name: "Panjabi" });
    sqlite.prepare("UPDATE products SET deleted_at = unixepoch() WHERE id = ?").run(id);

    await expect(product({ name: "New panjabi", slug: "panjabi" })).rejects.toThrow(
      "A product with this slug already exists",
    );
  });

  it("suffixes page handles the storefront reserves", async () => {
    const page = await createPage(db, createPageSchema.parse({ ...pageFields, title: "Cart" }));
    const dashboard = await createPage(
      db,
      createPageSchema.parse({ ...pageFields, title: "Dashboard" }),
      { reservedSlugs: new Set(["dashboard"]) },
    );
    const article = await createPage(db, createPageSchema.parse({ ...pageFields, title: "Cart", contentType: "article" }));

    expect(slugOf("pages", page.id)).toBe("cart-2");
    expect(slugOf("pages", dashboard.id)).toBe("dashboard-2");
    expect(slugOf("pages", article.id)).toBe("cart");
  });

  it("still refuses a typed reserved page handle", () => {
    expect(createPageSchema.safeParse({ ...pageFields, title: "Cart", slug: "cart" }).success).toBe(false);
  });

  it("transliterates attribute handles and suffixes a taken one", async () => {
    const fabric = await createAttribute(db, createAttributeSchema.parse({ name: "F5-কাপড়" }));
    const size = await createAttribute(db, createAttributeSchema.parse({ name: "Size" }));
    const sizeAgain = await createAttribute(db, createAttributeSchema.parse({ name: "Size!" }));

    expect(fabric.attribute.slug).toBe("f5-kapor");
    expect(size.attribute.slug).toBe("size");
    expect(sizeAgain.attribute.slug).toBe("size-2");
  });

  it("retries with the next handle when a concurrent create takes it first", async () => {
    const attempts: string[] = [];
    const handle = await insertWithDerivedHandle(
      {
        db,
        table: categories,
        column: categories.slug,
        isHandleConflict: (error) => String(error).includes("categories.slug"),
      },
      "Eid sale",
      "category",
      async (slug) => {
        attempts.push(slug);
        if (attempts.length === 1) {
          sqlite.exec(`INSERT INTO categories (id, name, slug) VALUES ('cat_race', 'Race', '${slug}');`);
        }
        sqlite.prepare("INSERT INTO categories (id, name, slug) VALUES (?, 'Eid sale', ?)").run(`cat_${attempts.length}`, slug);
        return slug;
      },
    );

    expect(attempts).toEqual(["eid-sale", "eid-sale-2"]);
    expect(handle).toBe("eid-sale-2");
  });
});
