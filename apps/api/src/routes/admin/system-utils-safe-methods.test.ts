import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("admin system utility safe methods", () => {
  it("keeps abandoned checkout listing GET side-effect free", () => {
    const source = readFileSync(`${ROUTES_DIR}/system-utils.ts`, "utf8");
    const listHandler = source.split("app.openapi(listAbandonedCheckoutsRoute")[1] ?? "";
    const getHandler = listHandler.split("// ── Bulk Delete Abandoned Checkouts")[0] ?? "";

    expect(listHandler).not.toBe("");
    expect(getHandler).not.toBe("");
    expect(getHandler).toContain("db.select()");
    expect(getHandler).not.toContain("db.delete(");
    expect(getHandler).not.toContain("db.update(");
    expect(getHandler).not.toContain("db.insert(");
    expect(getHandler).not.toContain("archiveStaleIncompleteOrders");
    expect(getHandler).not.toContain("cleanupStaleAbandonedCheckouts");
    expect(source).not.toContain("List abandoned checkouts with cleanup");
  });
});
