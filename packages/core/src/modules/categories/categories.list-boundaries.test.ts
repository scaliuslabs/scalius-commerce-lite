import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./categories.service.ts", import.meta.url)),
  "utf8",
);

describe("category list projection", () => {
  it("counts assigned non-trashed products per visible row", () => {
    expect(source).toContain("WHERE ${products.categoryId} = ${categories.id}");
    expect(source).toContain("AND ${products.deletedAt} IS NULL");
    expect(source).not.toContain("eq(products.isActive, true)");
  });

  it("does not scan and group the complete product table for every page", () => {
    expect(source).not.toContain(".groupBy(products.categoryId)");
    expect(source).toContain("const [countArr, results] = await db.batch([");
  });

  it("reads only affected or malformed collection configs during hard delete", () => {
    expect(source).toContain("INNER JOIN json_each(${JSON.stringify(claims)}) AS target");
    expect(source).toContain("json_extract(target.value, '$.id')");
    expect(source).toContain("WHEN json_valid(${collections.config}) = 0 THEN 1");
  });
});
