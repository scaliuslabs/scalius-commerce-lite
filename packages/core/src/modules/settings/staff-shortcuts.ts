// src/modules/settings/staff-shortcuts.ts
// One staff member's dashboard keyboard shortcuts ("G then O" -> Orders).
//
// Stored through the settings store as one per-user document
// (category `staff-shortcuts:<userId>`, key "document"): no KV mirror, no
// secrets, compare-and-swap writes. A save replaces the whole map, so a
// destination left out goes back to its default shortcut. An empty string
// turns that destination's default shortcut off.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { settings as settingsTable } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import {
  defineSettingsDocument,
  SETTINGS_DOCUMENT_ROW_KEY,
  type SettingsDocument,
} from "./settings-store";

export const STAFF_SHORTCUTS_MAX_ENTRIES = 80;
export const STAFF_SHORTCUT_PATH_MAX_LENGTH = 64;
export const STAFF_SHORTCUT_PATH_PATTERN = /^\/admin(\/[a-z0-9-]+){0,3}$/;
export const STAFF_SHORTCUT_SEQUENCE_PATTERN = /^g [a-z0-9]$/;

export type StaffShortcutMap = Record<string, string>;

export interface StaffShortcuts {
  shortcuts: StaffShortcutMap;
  /** 0 when this staff member has never saved shortcuts. */
  revision: number;
}

interface StaffShortcutsDocument {
  shortcuts: StaffShortcutMap;
}

function sequenceLabel(sequence: string): string {
  const [first = "", second = ""] = sequence.split(" ");
  return `${first.toUpperCase()} then ${second.toUpperCase()}`;
}

/** Why this map can't be saved, or null. Messages are shown to the merchant. */
export function staffShortcutsProblem(shortcuts: StaffShortcutMap): string | null {
  const entries = Object.entries(shortcuts);
  if (entries.length > STAFF_SHORTCUTS_MAX_ENTRIES) {
    return `At most ${STAFF_SHORTCUTS_MAX_ENTRIES} shortcuts can be saved`;
  }
  const seen = new Set<string>();
  for (const [path, sequence] of entries) {
    if (path.length > STAFF_SHORTCUT_PATH_MAX_LENGTH || !STAFF_SHORTCUT_PATH_PATTERN.test(path)) {
      return `"${path.slice(0, STAFF_SHORTCUT_PATH_MAX_LENGTH)}" is not a dashboard page`;
    }
    if (typeof sequence !== "string") return `The shortcut for ${path} is not valid`;
    if (sequence === "") continue;
    if (!STAFF_SHORTCUT_SEQUENCE_PATTERN.test(sequence)) {
      return `The shortcut for ${path} must be G then one letter or number`;
    }
    if (seen.has(sequence)) return `${sequenceLabel(sequence)} is used twice`;
    seen.add(sequence);
  }
  return null;
}

const staffShortcutMapSchema = z
  .record(z.string(), z.string())
  .superRefine((shortcuts, ctx) => {
    const problem = staffShortcutsProblem(shortcuts);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export function staffShortcutsDocumentKey(userId: string): string {
  return `staff-shortcuts:${userId}`;
}

export function staffShortcutsDocument(userId: string): SettingsDocument<StaffShortcutsDocument> {
  if (!userId) throw new ValidationError("A signed-in staff member is required");
  return defineSettingsDocument<StaffShortcutsDocument>({
    key: staffShortcutsDocumentKey(userId),
    schema: z.object({ shortcuts: staffShortcutMapSchema }),
    defaults: { shortcuts: {} },
  });
}

export async function readStaffShortcuts(db: Database, userId: string): Promise<StaffShortcuts> {
  const read = await staffShortcutsDocument(userId).readDetailed(db);
  return { shortcuts: read.value.shortcuts, revision: read.revision };
}

/**
 * Replaces the whole map. A stale `expectedRevision` is the store's 409
 * SETTINGS_REVISION_CONFLICT; an invalid map is a 400 with a readable reason.
 */
export async function writeStaffShortcuts(
  db: Database,
  userId: string,
  shortcuts: StaffShortcutMap,
  expectedRevision: number,
): Promise<StaffShortcuts> {
  const problem = staffShortcutsProblem(shortcuts);
  if (problem) throw new ValidationError(problem);
  const written = await staffShortcutsDocument(userId).write(
    db,
    { shortcuts },
    {},
    { expectedRevision, replace: true },
  );
  return { shortcuts: written.value.shortcuts, revision: written.revision };
}

/** Drops a staff member's shortcuts; batch it with the removal that ends their access. */
export function deleteStaffShortcutsStatement(db: Database, userId: string) {
  return db.delete(settingsTable).where(and(
    eq(settingsTable.key, SETTINGS_DOCUMENT_ROW_KEY),
    eq(settingsTable.category, staffShortcutsDocumentKey(userId)),
  ));
}
