import { describe, expect, it } from "vitest";
import { safeBatch } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";

import { SettingsRevisionConflictError } from "./settings-store";
import {
  deleteStaffShortcutsStatement,
  readStaffShortcuts,
  staffShortcutsProblem,
  writeStaffShortcuts,
} from "./staff-shortcuts";

describe("staff shortcut validation", () => {
  it("accepts dashboard paths, G sequences and turned-off defaults", () => {
    expect(staffShortcutsProblem({
      "/admin": "g h",
      "/admin/orders": "g o",
      "/admin/settings/users/roles": "g 9",
      "/admin/products": "",
      "/admin/customers": "",
    })).toBeNull();
  });

  it("refuses paths outside the dashboard", () => {
    for (const path of ["/orders", "/admin/", "/admin/Orders", "/admin/a/b/c/d", "/admin/o?x=1", `/admin/${"a".repeat(60)}`]) {
      expect(staffShortcutsProblem({ [path]: "g o" }), path).toMatch(/is not a dashboard page/);
    }
  });

  it("refuses sequences other than G then one letter or number", () => {
    for (const sequence of ["g", "o", "G O", "g oo", "x o", "g  o", "g _", "go"]) {
      expect(staffShortcutsProblem({ "/admin/orders": sequence }), sequence)
        .toBe("The shortcut for /admin/orders must be G then one letter or number");
    }
  });

  it("names a sequence used twice", () => {
    expect(staffShortcutsProblem({ "/admin/orders": "g o", "/admin/other": "g o" }))
      .toBe("G then O is used twice");
    expect(staffShortcutsProblem({ "/admin/orders": "", "/admin/other": "" })).toBeNull();
  });

  it("caps the map at 80 entries", () => {
    const map = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`/admin/page-${index}`, ""]),
    );
    expect(staffShortcutsProblem(map(80))).toBeNull();
    expect(staffShortcutsProblem(map(81))).toBe("At most 80 shortcuts can be saved");
  });
});

describe("staff shortcut storage", () => {
  it("reads revision 0 before anything is saved, then replaces the whole map per user", async () => {
    const { db } = createSqliteD1Database();
    expect(await readStaffShortcuts(db, "user_1")).toEqual({ shortcuts: {}, revision: 0 });

    const first = await writeStaffShortcuts(db, "user_1", { "/admin/orders": "g o", "/admin/products": "" }, 0);
    expect(first).toEqual({ shortcuts: { "/admin/orders": "g o", "/admin/products": "" }, revision: 1 });

    const second = await writeStaffShortcuts(db, "user_1", { "/admin/customers": "g c" }, 1);
    expect(second).toEqual({ shortcuts: { "/admin/customers": "g c" }, revision: 2 });
    expect(await readStaffShortcuts(db, "user_1")).toEqual(second);
    expect(await readStaffShortcuts(db, "user_2")).toEqual({ shortcuts: {}, revision: 0 });
  });

  it("refuses a stale revision and an invalid map without writing", async () => {
    const { db } = createSqliteD1Database();
    await writeStaffShortcuts(db, "user_1", { "/admin/orders": "g o" }, 0);
    await expect(writeStaffShortcuts(db, "user_1", { "/admin/orders": "g x" }, 0))
      .rejects.toBeInstanceOf(SettingsRevisionConflictError);
    await expect(writeStaffShortcuts(db, "user_1", { "/admin/a": "g a", "/admin/b": "g a" }, 1))
      .rejects.toThrow(new ValidationError("G then A is used twice"));
    expect(await readStaffShortcuts(db, "user_1")).toEqual({ shortcuts: { "/admin/orders": "g o" }, revision: 1 });
  });

  it("deletes only that staff member's row", async () => {
    const { db } = createSqliteD1Database();
    await writeStaffShortcuts(db, "user_1", { "/admin/orders": "g o" }, 0);
    await writeStaffShortcuts(db, "user_2", { "/admin/orders": "g p" }, 0);
    await safeBatch(db, [deleteStaffShortcutsStatement(db, "user_1")] as never);
    expect(await readStaffShortcuts(db, "user_1")).toEqual({ shortcuts: {}, revision: 0 });
    expect((await readStaffShortcuts(db, "user_2")).revision).toBe(1);
  });
});
