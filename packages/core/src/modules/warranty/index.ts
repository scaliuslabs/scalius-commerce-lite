// Warranty domain (Wave B design §5): reusable warranty policies with
// immutable revisions, the per-fulfilment-line warranty records (created and
// voided by database triggers) and claims as records backed by a
// `warranty_claim` conversation. Claims never move money, stock or order
// status (W5).
export * from "./browser";
export type { LineExtrasInput } from "../../utils/line-extras";
export {
  BUYER_WARRANTIES_MAX,
  countActiveBuyerWarranties,
  listBuyerWarranties,
  listLineWarranties,
  type BuyerWarranty,
  type BuyerWarrantyState,
} from "./extras";
export {
  archiveWarrantyPolicy,
  createWarrantyPolicy,
  getWarrantyPolicy,
  listWarrantyPolicies,
  normalizeWarrantyPolicyInput,
  restoreWarrantyPolicy,
  updateWarrantyPolicy,
  type WarrantyPolicyInput,
  type WarrantyPolicyView,
} from "./policies";
export {
  getWarrantyClaim,
  listWarrantyClaims,
  openWarrantyClaim,
  stageWarrantyClaimAttachment,
  updateWarrantyClaim,
  type ClaimActor,
  type OpenClaimInput,
  type OpenClaimResult,
  type StaffWarrantyClaim,
  type UpdateClaimInput,
} from "./claims";
export { readBuyerClaimThread, type BuyerClaimThread } from "./buyer-thread";
