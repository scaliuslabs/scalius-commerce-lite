export { createAuth, getAuth } from "./auth";
export type { Auth } from "./auth";
export {
  IDENTITY_HANDOFF_ACCOUNT_PROVIDER,
  IDENTITY_HANDOFF_MAX_TOKEN_LIFETIME_SECONDS,
  IDENTITY_HANDOFF_OWNER_ROLE,
  IdentityHandoffError,
  identityHandoff,
  mintIdentityHandoffToken,
  performIdentityHandoff,
  performIdentityRevocation,
  pruneExpiredIdentityHandoffEvents,
  verifyIdentityHandoffToken,
} from "./identity-handoff";
export type {
  IdentityHandoffClaims,
  IdentityHandoffPurpose,
  IdentityHandoffResult,
  IdentityRevocationResult,
} from "./identity-handoff";
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
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  completeAdminSetupClaimWithCredentialIdentity,
  createInvitedAdminCredentialAccount,
  isCredentialIdentityConflictError,
  prepareCredentialIdentity,
} from "./credential-account";
export type {
  CompleteFirstAdminInput,
  CreateInvitedAdminInput,
  PreparedCredentialIdentity,
  PrepareCredentialIdentityInput,
} from "./credential-account";
export {
  createScannerTokenClaim,
  consumeScannerTokenClaim,
  cleanupExpiredScannerTokenClaims,
} from "./scanner-token-claims";
export type {
  ConsumedScannerTokenClaim,
  ScannerTokenCleanupResult,
} from "./scanner-token-claims";
export { sendStaffPasswordChangedEmail } from "./staff-emails";
export {
  buildTotpUri,
  createPendingEmailMethodChallenge,
  createPendingTotpMethodChallenge,
  createTwoFactorRecoveryCodeStorage,
  getTwoFactorMethodChallengeIdentifier,
  readPendingTotpMethodChallenge,
  readPendingTwoFactorMethodChallenge,
  TWO_FACTOR_METHOD_CHALLENGE_PREFIX,
  TWO_FACTOR_METHOD_CHALLENGE_TTL_MS,
  verifyPendingTotpCode,
} from "./two-factor-method-challenge";
export type {
  CreatedEmailMethodChallenge,
  CreatedTotpMethodChallenge,
  PendingEmailMethodChallenge,
  PendingTotpMethodChallenge,
  PendingTwoFactorMethodChallenge,
} from "./two-factor-method-challenge";
