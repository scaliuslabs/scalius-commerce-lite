import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    buildUrlRedirectStatements,
    createUrlRedirect,
    normalizeRedirectPath,
    productPath,
    resolveUrlRedirect,
} from "./url-redirects";

describe("URL redirects", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    beforeEach(() => ({ sqlite, db } = createSqliteD1Database()));
    afterEach(() => sqlite.close());

    const rename = (from: string, to: string) =>
        db.batch(buildUrlRedirectStatements(db, productPath(from), productPath(to)) as never);
    const all = () => sqlite.prepare("SELECT from_path, to_path FROM url_redirects ORDER BY from_path").all();

    it("normalizes typed addresses to store paths and refuses what can't be one", () => {
        expect(normalizeRedirectPath("products/old-lamp/")).toBe("/products/old-lamp");
        expect(normalizeRedirectPath("https://shop.example.com/products/a")).toBe("/products/a");
        expect(normalizeRedirectPath("//evil.example/x")).toBeNull();
        expect(normalizeRedirectPath("/a?b=1")).toBeNull();
        expect(normalizeRedirectPath("/a b")).toBeNull();
    });

    it("keeps every old handle one hop from the newest, and a handle renamed back is a page again", async () => {
        await rename("lamp", "desk-lamp");
        await rename("desk-lamp", "beam-lamp");
        expect(all()).toEqual([
            { from_path: "/products/desk-lamp", to_path: "/products/beam-lamp" },
            { from_path: "/products/lamp", to_path: "/products/beam-lamp" },
        ]);
        await rename("beam-lamp", "lamp");
        expect(all()).toEqual([
            { from_path: "/products/beam-lamp", to_path: "/products/lamp" },
            { from_path: "/products/desk-lamp", to_path: "/products/lamp" },
        ]);
        expect(await resolveUrlRedirect(db, "/products/desk-lamp/")).toBe("/products/lamp");
        expect(await resolveUrlRedirect(db, "/products/lamp")).toBeNull();
    });

    it("advances the `rd` dependency with every change", async () => {
        await rename("a-lamp", "b-lamp");
        expect(sqlite.prepare("SELECT count(*) AS n FROM cache_dep WHERE dep = 'rd'").get()).toEqual({ n: 1 });
    });

    it("follows a merchant's target that itself redirects and refuses a loop", async () => {
        await createUrlRedirect(db, { fromPath: "/old-page", toPath: "/pages/about" });
        await createUrlRedirect(db, { fromPath: "/flyer", toPath: "/old-page" });
        expect(await resolveUrlRedirect(db, "/flyer")).toBe("/pages/about");
        await expect(createUrlRedirect(db, { fromPath: "/pages/about", toPath: "/old-page" })).rejects.toThrow(/each other/);
    });
});
