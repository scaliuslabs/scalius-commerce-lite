import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const adminSource = readFileSync(
    fileURLToPath(new URL("./products.admin.ts", import.meta.url)),
    "utf8",
);
const variantSource = readFileSync(
    fileURLToPath(new URL("./products.variants.ts", import.meta.url)),
    "utf8",
);

describe("product media command boundaries", () => {
    it("moves retained orders out of the final unique range before delete/update/insert", () => {
        const functionStart = adminSource.indexOf("function buildProductMediaUpdateStatements");
        const stage = adminSource.indexOf("PRODUCT_MEDIA_REORDER_OFFSET", functionStart);
        const clearSku = adminSource.indexOf("imageId: null", stage);
        const remove = adminSource.indexOf("db.delete(productMedia)", clearSku);
        const retainedUpdate = adminSource.indexOf("plan.retainedRows.length", remove);
        const newInsert = adminSource.indexOf("buildProductMediaInsertStatements", retainedUpdate);
        expect(stage).toBeGreaterThan(functionStart);
        expect(clearSku).toBeGreaterThan(stage);
        expect(remove).toBeGreaterThan(clearSku);
        expect(retainedUpdate).toBeGreaterThan(remove);
        expect(newInsert).toBeGreaterThan(retainedUpdate);
        expect(adminSource).toContain("const PRODUCT_MEDIA_INSERT_CHUNK = 12");
    });

    it("requires explicit affected-SKU acknowledgement and returns bounded conflict details", () => {
        expect(adminSource).toContain("PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT");
        expect(adminSource).toContain("affectedAssociationIds.slice(0, 20)");
        expect(adminSource).toContain("affected.slice(0, 5)");
        expect(adminSource).toContain("acknowledgedSkuImageRemovalIds ?? []");
    });

    it("never writes copied product image URLs and allows trash only for the unchanged exact SKU image", () => {
        expect(adminSource).not.toContain("db.insert(productImages)");
        expect(adminSource).not.toContain("db.update(productImages)");
        expect(variantSource).toContain("imageId === retainedImageId && association?.status === \"trashed\"");
        expect(variantSource).toContain("eq(media.kind, \"image\")");
    });
});
