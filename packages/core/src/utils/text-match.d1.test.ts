import { describe, expect, it } from "vitest";
import { categories } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { containsText, handleOrNumberedCopy, startsWithText } from "./text-match";

describe("text matching without LIKE (D1 refuses a pattern over 50 bytes)", () => {
  const longBangla = "হাতে বোনা জামদানি শাড়ি উৎসব সংস্করণ";
  const setup = () => {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`INSERT INTO categories (id, name, slug) VALUES
      ('cat_a', 'Summer 100% cotton_tees', 'summer-cotton-tees'),
      ('cat_b', 'Summer 100x cottonXtees', 'summer-cotton-tees-2'),
      ('cat_c', '${longBangla} ও আরও', 'summer-cotton-tees-extra'),
      ('cat_d', 'Winter', 'summer-cotton-teesx')`);
    const ids = (where: ReturnType<typeof containsText>) =>
      harness.db.select({ id: categories.id }).from(categories).where(where).orderBy(categories.id).all()
        .then((rows) => rows.map((row) => row.id));
    return { ...harness, ids };
  };

  it("the test database refuses a long LIKE pattern, as D1 does", () => {
    const { sqlite } = setup();
    expect(() => sqlite.prepare("SELECT 1 WHERE 'a' LIKE ?").get(`%${longBangla}%`))
      .toThrow(/LIKE or GLOB pattern too complex/);
  });

  it("finds a long Bangla term, ignores ASCII case and treats % and _ literally", async () => {
    const { ids } = setup();
    expect(Buffer.byteLength(longBangla)).toBeGreaterThan(50);
    expect(await ids(containsText(categories.name, longBangla))).toEqual(["cat_c"]);
    expect(await ids(containsText(categories.name, "100% COTTON_"))).toEqual(["cat_a"]);
  });

  it("matches a prefix and a handle's numbered copies only", async () => {
    const { ids } = setup();
    expect(await ids(startsWithText(categories.slug, "summer-cotton-tees-"))).toEqual(["cat_b", "cat_c"]);
    expect(await ids(handleOrNumberedCopy(categories.slug, "summer-cotton-tees"))).toEqual(["cat_a", "cat_b", "cat_c"]);
  });
});
