// Browser-safe entry: pure types and constants only (no database, no domain
// index). Safe to import from the dashboard and from any domain.
// B5 fills the warranty domain; these names are the contract it keeps.

/** `warranty_policies.provider`: who honours the warranty (Wave B design §5.1). */
export const WARRANTY_PROVIDERS = ["brand", "store"] as const;
export type WarrantyProvider = (typeof WARRANTY_PROVIDERS)[number];

/** `warranty_policies.duration_unit`, stored as the SQLite date modifier word. */
export const WARRANTY_DURATION_UNITS = ["days", "months", "years"] as const;
export type WarrantyDurationUnit = (typeof WARRANTY_DURATION_UNITS)[number];

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

/** One warranty record of an order line (`extras.warranty[]`, one per fulfilment line). */
export interface LineWarrantyExtra {
  warrantyId: string;
  policyName: string;
  provider: WarrantyProvider;
  quantity: number;
  /** Epoch seconds: the handover recorded by the fulfilment ledger. */
  startsAt: number;
  expiresAt: number;
  replacementUntil: number | null;
  voided: boolean;
  /** The open or in-progress claim on this warranty, when one exists. */
  openClaimId: string | null;
}
