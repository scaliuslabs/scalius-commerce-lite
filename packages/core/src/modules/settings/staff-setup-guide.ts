// src/modules/settings/staff-setup-guide.ts
// Whether one staff member dismissed Home's setup guide.
//
// Stored like the staff shortcuts: one per-user settings document (category
// `staff-setup-guide:<userId>`, key "document"), so it follows the person to
// every browser and goes with them when they are removed
// (`deleteStaffPreferencesStatement`). The guide's steps are never stored:
// each is read from the store's own data.

import { z } from "zod";
import { ValidationError } from "@scalius/core/errors";
import type { Database } from "@scalius/database/client";
import { defineSettingsDocument, type SettingsDocument } from "../../settings-store";

interface StaffSetupGuideDocument {
  dismissed: boolean;
}

export function staffSetupGuideDocumentKey(userId: string): string {
  return `staff-setup-guide:${userId}`;
}

export function staffSetupGuideDocument(userId: string): SettingsDocument<StaffSetupGuideDocument> {
  if (!userId) throw new ValidationError("A signed-in staff member is required");
  return defineSettingsDocument<StaffSetupGuideDocument>({
    key: staffSetupGuideDocumentKey(userId),
    schema: z.object({ dismissed: z.boolean() }),
    defaults: { dismissed: false },
  });
}

export async function readSetupGuideDismissed(db: Database, userId: string): Promise<boolean> {
  return (await staffSetupGuideDocument(userId).read(db)).dismissed;
}

/** Hides the guide for this staff member. Saying it twice changes nothing. */
export async function dismissSetupGuide(db: Database, userId: string): Promise<void> {
  await staffSetupGuideDocument(userId).write(db, { dismissed: true });
}
