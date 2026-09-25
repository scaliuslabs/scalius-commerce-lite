// Browser-safe entry: pure types and constants only (no database, no domain
// index). Safe to import from the dashboard and from any domain.
// B3 fills the digital domain; these names are the contract it keeps.

/** `digital_assets.kind`: a downloadable file, or a pool of licence keys (Wave B design §3.1). */
export const DIGITAL_ASSET_KINDS = ["file", "licence_keys"] as const;
export type DigitalAssetKind = (typeof DIGITAL_ASSET_KINDS)[number];

/** `digital_asset_uploads.status` (multipart upload sessions). */
export const DIGITAL_UPLOAD_STATUSES = ["uploading", "complete", "aborted"] as const;
export type DigitalUploadStatus = (typeof DIGITAL_UPLOAD_STATUSES)[number];

/** `digital_licence_keys.status`; assignment is final. */
export const LICENCE_KEY_STATUSES = ["available", "assigned", "revoked"] as const;
export type LicenceKeyStatus = (typeof LICENCE_KEY_STATUSES)[number];

/** Limits from design §3 and §14 (decisions 20, 21). */
export const DIGITAL_LIMITS = {
  defaultDownloadLimit: 5,
  maxDownloadLimit: 100,
  maxAccessDays: 3650,
  maxFileAssetsPerVariant: 10,
  uploadPartBytes: 50 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxKeysPerImport: 500,
  maxKeyLength: 200,
} as const;

/** One downloadable file a line received. */
export interface LineDownloadExtra {
  entitlementId: string;
  displayName: string;
  downloadCount: number;
  /** null = unlimited. */
  downloadLimit: number | null;
  /** Epoch seconds; null = never expires. */
  expiresAt: number | null;
  revoked: boolean;
}

/** One licence key a line received; the plaintext is only ever revealed by a POST. */
export interface LineLicenceKeyExtra {
  keyId: string;
  last4: string;
}

/** What a digital order line delivered (`extras.downloads` and `extras.licenceKeys`). */
export interface LineDigitalExtra {
  downloads: readonly LineDownloadExtra[];
  licenceKeys: readonly LineLicenceKeyExtra[];
}
