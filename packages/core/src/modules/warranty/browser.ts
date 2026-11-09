// Browser-safe entry: pure types and constants only (no database, no domain
// index). Safe to import from the dashboard and from any domain.

/** `warranty_policies.provider`: who honours the warranty (Wave B design §5.1). */
export const WARRANTY_PROVIDERS = ["brand", "store"] as const;
export type WarrantyProvider = (typeof WARRANTY_PROVIDERS)[number];

/** `warranty_policies.duration_unit`, stored as the SQLite date modifier word. */
export const WARRANTY_DURATION_UNITS = ["days", "months", "years"] as const;
export type WarrantyDurationUnit = (typeof WARRANTY_DURATION_UNITS)[number];
/** A duration as read: a period unit, or `lifetime` (no end; `durationValue` null). */
export type WarrantyDurationKind = WarrantyDurationUnit | "lifetime";

/** `warranty_claims.status`. */
export const WARRANTY_CLAIM_STATUSES = ["open", "in_progress", "resolved", "rejected"] as const;
export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];

/** `warranty_claims.resolution`; claims are records and never move money or stock themselves. */
export const WARRANTY_CLAIM_RESOLUTIONS = ["repair", "replacement", "refund", "other"] as const;
export type WarrantyClaimResolution = (typeof WARRANTY_CLAIM_RESOLUTIONS)[number];

/** `warranty_claims.opened_by`. */
export const WARRANTY_CLAIM_OPENERS = ["customer", "guest_receipt", "staff"] as const;
export type WarrantyClaimOpener = (typeof WARRANTY_CLAIM_OPENERS)[number];

/** Limits from design §5.1. */
export const WARRANTY_LIMITS = {
  maxNameLength: 80,
  minDurationValue: 1,
  maxDurationValue: 120,
  maxReplacementDays: 90,
  maxTermsLength: 4000,
} as const;

/** The latest claim on a warranty (an open one wins over closed ones). */
export interface LineWarrantyClaim {
  id: string;
  conversationId: string;
  status: WarrantyClaimStatus;
  resolution: WarrantyClaimResolution | null;
}

/**
 * One warranty record of an order line (`extras.warranty[]`): one per
 * fulfilment line of the store's warranty, one per unit an app issued.
 */
export interface LineWarrantyExtra {
  warrantyId: string;
  /** An app record's buyer-facing id (`8K4-XP2-MN9`); null for the store's own warranty. */
  code: string | null;
  /** The app that issued the record; null for the store's own warranty. */
  appId: string | null;
  /** An app record's unit of its line (1 to the line's quantity); null for the store's own warranty. */
  unitNumber: number | null;
  /** The frozen revision's buyer-facing terms. */
  policyName: string;
  provider: WarrantyProvider;
  /** Null for a lifetime warranty. */
  durationValue: number | null;
  durationUnit: WarrantyDurationKind;
  replacementDays: number | null;
  terms: string | null;
  quantity: number;
  /** Epoch seconds: the handover recorded by the fulfilment ledger, or when the app issued it. */
  startsAt: number;
  /** Null: a lifetime warranty, which never ends. */
  expiresAt: number | null;
  replacementUntil: number | null;
  voided: boolean;
  /** The open or in-progress claim on this warranty, when one exists. */
  openClaimId: string | null;
  claim: LineWarrantyClaim | null;
}
