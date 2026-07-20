import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../migrations/0041_enforce_delivery_location_identity.sql",
  ),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const schema = `
  CREATE TABLE delivery_locations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    external_ids TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at INTEGER
  );
`;

function execute(seed: string, assertions = "") {
  return spawnSync("sqlite3", [":memory:"], {
    input: `.bail on\n${schema}\n${seed}\n${migration}\n${assertions}`,
    encoding: "utf8",
  });
}

describe("delivery location identity migration", () => {
  it("retires indistinguishable active siblings and preserves deterministic identities", () => {
    const result = execute(
      `
        INSERT INTO delivery_locations
          (id, name, type, parent_id, external_ids, is_active, created_at)
        VALUES
          ('city_manual', 'Dhaka', 'city', NULL, '{}', 1, 10),
          ('city_provider', ' dhaka ', 'city', NULL, '{"pathao":"1"}', 1, 1),
          ('city_other', 'Chattogram', 'city', NULL, '{"pathao":"2"}', 1, 2),
          ('zone_20', 'Dhanmondi', 'zone', 'city_manual', '{"pathao":"20"}', 1, 3),
          ('zone_10', ' dhanmondi ', 'zone', 'city_manual', '{"pathao":"10"}', 1, 4),
          ('zone_other_parent', 'Dhanmondi', 'zone', 'city_other', '{"pathao":"30"}', 1, 5),
          ('area_200', 'Mohakhali Flyover', 'area', 'zone_10', '{"pathao":"200"}', 1, 6),
          ('area_100', ' mohakhali flyover ', 'area', 'zone_10', '{"pathao":"100"}', 1, 7),
          ('area_inactive', 'Mohakhali Flyover', 'area', 'zone_10', '{"pathao":"300"}', 0, 8);
      `,
      `
        SELECT group_concat(id || ':' || is_active, ',')
        FROM (SELECT id, is_active FROM delivery_locations ORDER BY id);
        SELECT count(*) FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'delivery_locations_active_city_name_uidx',
          'delivery_locations_active_child_name_uidx'
        );
      `,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "area_100:1,area_200:0,area_inactive:0,city_manual:1,city_other:1,city_provider:0,zone_10:1,zone_20:0,zone_other_parent:1",
      "2",
    ]);
  });

  it("rejects new active duplicates but permits inactive and separate-parent rows", () => {
    const activeDuplicate = execute(
      `
        INSERT INTO delivery_locations (id, name, type, parent_id)
        VALUES ('city_1', 'Dhaka', 'city', NULL);
      `,
      `
        INSERT INTO delivery_locations (id, name, type, parent_id)
        VALUES ('city_2', ' dhaka ', 'city', NULL);
      `,
    );
    expect(activeDuplicate.status).not.toBe(0);
    expect(activeDuplicate.stderr).toContain(
      "delivery_locations_active_city_name_uidx",
    );

    const allowed = execute(
      `
        INSERT INTO delivery_locations (id, name, type, parent_id)
        VALUES
          ('city_1', 'Dhaka', 'city', NULL),
          ('city_2', 'Chattogram', 'city', NULL),
          ('zone_1', 'Central', 'zone', 'city_1'),
          ('zone_2', 'Central', 'zone', 'city_2');
        INSERT INTO delivery_locations
          (id, name, type, parent_id, is_active)
        VALUES ('zone_retired', ' Central ', 'zone', 'city_1', 0);
      `,
    );
    expect(allowed.status, allowed.stderr).toBe(0);
  });
});
