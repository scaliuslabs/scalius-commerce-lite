// Migration 0094: the rendition ladder gained 240 and 400 px steps, so every
// still image rendered on the old ladder publishes its original again until
// the render job writes the full ladder. Videos, originals and version
// counters are untouched (renditions are derived storage, not an edit).
import { describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const MIGRATION = "0094_media_rendition_ladder";

const SEED = `
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, width, height, variant_width, status, version, updated_at, trashed_at) VALUES
        ('med_rendered01', 'a.jpg', 'image', 'media/med_rendered01.jpg', 10, 'image/jpeg', 2000, 2000, 1600, 'ready', 3, 1000, NULL),
        ('med_smallpng01', 'b.png', 'image', 'media/med_smallpng01.png', 10, 'image/png', 300, 300, 300, 'trashed', 1, 1000, 1000),
        ('med_original01', 'c.jpg', 'image', 'media/med_original01.jpg', 10, 'image/jpeg', 800, 800, NULL, 'ready', 1, 1000, NULL),
        ('med_videoclip1', 'd.mp4', 'video', 'media/med_videoclip1.mp4', 10, 'video/mp4', 1280, 720, NULL, 'ready', 1, 1000, NULL);
`;

describe(MIGRATION, () => {
    it.each(["d1", "turso"] as const)("sends every rendered image back to its original on %s", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0094_" });
        sqlite.exec(SEED);
        sqlite.exec(compiledMigrationSql(provider, "0095_", "0094_"));
        expect(sqlite.prepare("SELECT id, variant_width, version, updated_at FROM media ORDER BY id").all()).toEqual([
            { id: "med_original01", variant_width: null, version: 1, updated_at: 1000 },
            { id: "med_rendered01", variant_width: null, version: 3, updated_at: 1000 },
            { id: "med_smallpng01", variant_width: null, version: 1, updated_at: 1000 },
            { id: "med_videoclip1", variant_width: null, version: 1, updated_at: 1000 },
        ]);
        expect(sqlite.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
            .toEqual({ version: 94, name: MIGRATION });
    });
});
