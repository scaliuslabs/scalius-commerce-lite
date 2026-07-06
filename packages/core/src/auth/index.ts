export { createAuth, getAuth } from "./auth";
export type { Auth } from "./auth";
export {
  enforceAdminSetupRateLimit,
  adminPrincipalExists,
  claimAdminSetup,
  assertAdminSetupClaimActive,
  completeAdminSetupClaimWithUserPromotion,
  markAdminSetupClaimCompleted,
  markAdminSetupClaimFailed,
} from "./admin-setup";
export type { AdminPrincipalExistsDb, ClaimedAdminSetup } from "./admin-setup";
export {
  createScannerTokenClaim,
  consumeScannerTokenClaim,
  cleanupExpiredScannerTokenClaims,
} from "./scanner-token-claims";
export type {
  ConsumedScannerTokenClaim,
  ScannerTokenCleanupResult,
} from "./scanner-token-claims";
