// Agent operation registry rows for the dashboard review routes (Wave B).
// Moderation, replies and reviewer threads are staff judgements over buyer
// text, so the review routes stay a staff browser surface until a reviewed
// agent intent exists.
import type { OperationRegistryEntry } from "./entry";

const STAFF_MODERATION_ONLY =
  "Review moderation, replies and reviewer threads are staff judgements over buyer text; they stay a staff browser surface until a reviewed agent intent exists.";

const staffOnly = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  exposure: "excluded",
  reason: STAFF_MODERATION_ONLY,
  ...overrides,
});

export const DASHBOARD_REVIEW_OPERATIONS = {
  "dashboard.reviews.conversation": staffOnly(),
  "dashboard.reviews.get": staffOnly(),
  "dashboard.reviews.list": staffOnly(),
  "dashboard.reviews.moderate": staffOnly({ idempotency: "required" }),
  "dashboard.reviews.reply": staffOnly({ revision: "required" }),
  "dashboard.reviews.settings_get": staffOnly(),
  "dashboard.reviews.settings_update": staffOnly({ revision: "required" }),
  "dashboard.reviews.summary": staffOnly(),
} satisfies Record<string, OperationRegistryEntry>;
