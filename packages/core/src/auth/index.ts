export { createAuth, getAuth } from "./auth";
export type { Auth } from "./auth";
export {
  enforceAdminSetupRateLimit,
  claimAdminSetup,
  assertAdminSetupClaimActive,
  completeAdminSetupClaimWithUserPromotion,
  markAdminSetupClaimCompleted,
  markAdminSetupClaimFailed,
} from "./admin-setup";
export type { ClaimedAdminSetup } from "./admin-setup";
