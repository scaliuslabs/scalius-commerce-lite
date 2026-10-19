// Agent operation registry rows for the dashboard review routes (Wave B).
//
// Moderation and replies are staff judgements over buyer text, so they sit
// behind the opt-in grant scope `review_moderation`: no preset grant reaches
// them; a Custom grant whose permission snapshot holds reviews.view /
// reviews.moderate does. Opening a private reviewer thread also needs the
// inbox scope's permission (conversations.reply).
import type { OperationRegistryEntry } from "./entry";

const moderation = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  grantScope: "review_moderation",
  uncurated: true,
  ...overrides,
});

export const DASHBOARD_REVIEW_OPERATIONS = {
  "dashboard.reviews.conversation": moderation(),
  "dashboard.reviews.get": moderation(),
  "dashboard.reviews.list": moderation(),
  "dashboard.reviews.moderate": moderation({ idempotency: "required" }),
  "dashboard.reviews.reply": moderation({ revision: "required" }),
  "dashboard.reviews.settings_get": moderation(),
  "dashboard.reviews.settings_update": moderation({ revision: "required" }),
  "dashboard.reviews.summary": moderation(),
} satisfies Record<string, OperationRegistryEntry>;
