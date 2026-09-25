/**
 * Warranty policies and claims (Wave B §5). Pure: the dashboard, the API and
 * the storefront share the vocabulary and bounds, and `warrantyExpiresAt` is
 * the same date arithmetic the `order_item_warranties` trigger runs in SQLite.
 */

/**
 * Stored as the SQLite date modifier word, so the trigger builds
 * `'+' || duration_value || ' ' || duration_unit` with no `CASE`.
 */
export const WARRANTY_DURATION_UNITS = ["days", "months", "years"] as const;
export type WarrantyDurationUnit = (typeof WARRANTY_DURATION_UNITS)[number];

/** Who honours the warranty: the manufacturer/brand or the store itself. */
export const WARRANTY_PROVIDERS = ["brand", "store"] as const;
export type WarrantyProvider = (typeof WARRANTY_PROVIDERS)[number];

/** Lengths count Unicode code points (SQLite `length()`). */
export const WARRANTY_LIMITS = {
  nameLength: 80,
  termsLength: 4_000,
  durationValue: { min: 1, max: 120 },
  /** `replacement_days` is 0–90 or NULL (no replacement window). */
  replacementDays: { min: 0, max: 90 },
} as const;

export const WARRANTY_CLAIM_STATUSES = ["open", "in_progress", "resolved", "rejected"] as const;
export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];
/** Statuses that hold the one-open-claim-per-warranty slot. */
export const OPEN_WARRANTY_CLAIM_STATUSES = ["open", "in_progress"] as const satisfies readonly WarrantyClaimStatus[];

export const WARRANTY_CLAIM_RESOLUTIONS = ["repair", "replacement", "refund", "other"] as const;
export type WarrantyClaimResolution = (typeof WARRANTY_CLAIM_RESOLUTIONS)[number];

export const WARRANTY_CLAIM_OPENERS = ["customer", "guest_receipt", "staff"] as const;
export type WarrantyClaimOpener = (typeof WARRANTY_CLAIM_OPENERS)[number];

export function isWarrantyDurationUnit(value: unknown): value is WarrantyDurationUnit {
  return typeof value === "string" && (WARRANTY_DURATION_UNITS as readonly string[]).includes(value);
}

export function isWarrantyProvider(value: unknown): value is WarrantyProvider {
  return typeof value === "string" && (WARRANTY_PROVIDERS as readonly string[]).includes(value);
}

export function isWarrantyClaimStatus(value: unknown): value is WarrantyClaimStatus {
  return typeof value === "string" && (WARRANTY_CLAIM_STATUSES as readonly string[]).includes(value);
}

export function isWarrantyClaimResolution(value: unknown): value is WarrantyClaimResolution {
  return typeof value === "string" && (WARRANTY_CLAIM_RESOLUTIONS as readonly string[]).includes(value);
}

export function isWarrantyDurationValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= WARRANTY_LIMITS.durationValue.min && value <= WARRANTY_LIMITS.durationValue.max;
}

export function isWarrantyReplacementDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= WARRANTY_LIMITS.replacementDays.min && value <= WARRANTY_LIMITS.replacementDays.max;
}

/** The SQLite modifier the trigger builds: `+12 months`. */
export function warrantyDurationModifier(value: number, unit: WarrantyDurationUnit): string {
  return `+${value} ${unit}`;
}

const SECONDS_PER_DAY = 86_400;

function assertEpochSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Warranty dates are non-negative integer epoch seconds.");
  }
}

/**
 * The warranty end as SQLite computes it in the trigger:
 * `unixepoch(start, 'unixepoch', '+<value> <unit>')`.
 *
 * - `days`: `start + value · 86400`.
 * - `months`/`years`: add to the UTC month/year and keep the day of month and
 *   time; a day past the end of the target month overflows into the next month
 *   (SQLite's default "ceiling" behaviour): Jan 31 + 1 month = Mar 3 (Mar 2 in
 *   a leap year), Feb 29 + 1 year = Mar 1.
 *
 * Postgres `+ interval '1 month'` clamps to the month end instead (Feb 28), so
 * the Postgres trigger must reproduce this overflow for parity (W3).
 */
export function warrantyExpiresAt(startEpochSeconds: number, value: number, unit: WarrantyDurationUnit): number {
  assertEpochSeconds(startEpochSeconds);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Warranty duration is a non-negative integer.");
  if (unit === "days") return startEpochSeconds + value * SECONDS_PER_DAY;
  const start = new Date(startEpochSeconds * 1000);
  const months = unit === "months" ? value : value * 12;
  const end = new Date(0);
  // setUTCFullYear normalizes an out-of-range month and day exactly like SQLite's
  // computeJD: months carry into years, then extra days roll into the next month.
  end.setUTCFullYear(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate());
  end.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), 0);
  return Math.floor(end.getTime() / 1000);
}

/**
 * The replacement window end: `unixepoch(start, 'unixepoch', '+<days> days')`,
 * `null` when the policy has no replacement window (`replacement_days` NULL).
 * A 0-day window ends at the start.
 */
export function warrantyReplacementUntil(startEpochSeconds: number, replacementDays: number | null): number | null {
  assertEpochSeconds(startEpochSeconds);
  if (replacementDays === null) return null;
  if (!Number.isSafeInteger(replacementDays) || replacementDays < 0) {
    throw new RangeError("Replacement days are a non-negative integer.");
  }
  return startEpochSeconds + replacementDays * SECONDS_PER_DAY;
}

/** Whether a warranty is active at `nowEpochSeconds`: not voided and `expires_at > now`. */
export function isWarrantyActive(
  warranty: { expiresAt: number; voidedAt: number | null },
  nowEpochSeconds: number,
): boolean {
  return warranty.voidedAt === null && warranty.expiresAt > nowEpochSeconds;
}

const UNIT_WORDS: Readonly<Record<WarrantyDurationUnit, readonly [singular: string, plural: string]>> = {
  days: ["day", "days"],
  months: ["month", "months"],
  years: ["year", "years"],
};

/** "1 year", "18 months", "7 days". English; the storefront localizes. */
export function warrantyDurationLabel(value: number, unit: WarrantyDurationUnit): string {
  const [singular, plural] = UNIT_WORDS[unit];
  return `${value} ${value === 1 ? singular : plural}`;
}

export interface WarrantyLabelInput {
  durationValue: number;
  durationUnit: WarrantyDurationUnit;
  provider: WarrantyProvider;
  replacementDays: number | null;
}

/**
 * The buyer-facing trust line: "1 year brand warranty · 7-day replacement".
 * The replacement part is omitted when there is no window (NULL or 0 days).
 * English only; the storefront localizes from the same fields.
 */
export function warrantySummaryLabel(policy: WarrantyLabelInput): string {
  const warranty = `${warrantyDurationLabel(policy.durationValue, policy.durationUnit)} ${policy.provider} warranty`;
  return policy.replacementDays ? `${warranty} · ${policy.replacementDays}-day replacement` : warranty;
}
