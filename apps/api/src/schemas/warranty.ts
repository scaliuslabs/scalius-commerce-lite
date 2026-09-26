// OpenAPI schemas for warranty policies, buyer warranties and claims (Wave B
// §5, §7). Dates are ISO strings; claim bodies never enter URLs or logs.
import { z } from "@hono/zod-openapi";
import {
  WARRANTY_CLAIM_OPENERS,
  WARRANTY_CLAIM_RESOLUTIONS,
  WARRANTY_CLAIM_STATUSES,
  WARRANTY_DURATION_UNITS,
  WARRANTY_LIMITS,
  WARRANTY_PROVIDERS,
} from "@scalius/shared/warranty";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import type {
  BuyerWarranty,
  StaffWarrantyClaim,
  WarrantyPolicyView,
} from "@scalius/core/modules/warranty";
import { conversationAttachmentIdSchema } from "./conversations";

const isoTimestamp = z.string().openapi({ format: "date-time" });

export function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function isoOrNull(seconds: number | null): string | null {
  return seconds === null ? null : isoFromSeconds(seconds);
}

export const warrantyPolicyIdSchema = z.string().regex(/^wrp_[A-Za-z0-9_-]{8,64}$/);
export const warrantyIdSchema = z.string().regex(/^wty_[A-Za-z0-9_-]{8,80}$/);
export const warrantyClaimIdSchema = z.string().regex(/^wcl_[A-Za-z0-9_-]{8,64}$/);

const providerSchema = z.enum(WARRANTY_PROVIDERS);
const durationUnitSchema = z.enum(WARRANTY_DURATION_UNITS);
const claimStatusSchema = z.enum(WARRANTY_CLAIM_STATUSES);
const claimResolutionSchema = z.enum(WARRANTY_CLAIM_RESOLUTIONS);

// ─── Policies (dashboard) ────────────────────────────────────────────────

const policyFields = {
  name: z.string().max(WARRANTY_LIMITS.nameLength * 2).openapi({ description: "Buyer-facing name, like “1 year official warranty”" }),
  provider: providerSchema.openapi({ description: "Who honours it: the brand (official) or the store" }),
  durationValue: z.number().int().min(WARRANTY_LIMITS.durationValue.min).max(WARRANTY_LIMITS.durationValue.max),
  durationUnit: durationUnitSchema,
  replacementDays: z.number().int().min(WARRANTY_LIMITS.replacementDays.min).max(WARRANTY_LIMITS.replacementDays.max).nullable()
    .openapi({ description: "Free replacement window in days from handover; null (or 0) for none" }),
  terms: z.string().max(WARRANTY_LIMITS.termsLength * 2).nullable().openapi({ description: "Plain-text terms shown to buyers" }),
};

export const warrantyPolicyBodySchema = z.object(policyFields).strict();
export const warrantyPolicyUpdateBodySchema = z.object({
  ...policyFields,
  version: z.number().int().positive().openapi({ description: "The version the editor loaded" }),
}).strict();

export const warrantyPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: providerSchema,
  durationValue: z.number().int(),
  durationUnit: durationUnitSchema,
  replacementDays: z.number().int().nullable(),
  terms: z.string().nullable(),
  currentRevisionId: z.string(),
  revision: z.number().int().openapi({ description: "Current revision number; each edit makes the next one" }),
  archivedAt: isoTimestamp.nullable(),
  version: z.number().int(),
  productCount: z.number().int().openapi({ description: "Live products using this policy" }),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).openapi("WarrantyPolicy");

export function presentWarrantyPolicy(policy: WarrantyPolicyView) {
  return {
    ...policy,
    archivedAt: isoOrNull(policy.archivedAt),
    createdAt: isoFromSeconds(policy.createdAt),
    updatedAt: isoFromSeconds(policy.updatedAt),
  };
}

// ─── Claims (dashboard) ──────────────────────────────────────────────────

export const staffWarrantyClaimSchema = z.object({
  id: z.string(),
  status: claimStatusSchema,
  resolution: claimResolutionSchema.nullable(),
  quantity: z.number().int(),
  openedBy: z.enum(WARRANTY_CLAIM_OPENERS),
  version: z.number().int(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  closedAt: isoTimestamp.nullable(),
  conversationId: z.string(),
  order: z.object({ id: z.string(), orderNumber: z.string() }),
  item: z.object({
    id: z.string(),
    productId: z.string().nullable(),
    productName: z.string().nullable(),
    variantLabel: z.string().nullable(),
    productSlug: z.string().nullable(),
  }),
  warranty: z.object({
    id: z.string(),
    quantity: z.number().int(),
    startsAt: isoTimestamp,
    expiresAt: isoTimestamp,
    replacementUntil: isoTimestamp.nullable(),
    voidedAt: isoTimestamp.nullable(),
    active: z.boolean(),
  }),
  policy: z.object({
    policyId: z.string(),
    revisionId: z.string(),
    revision: z.number().int(),
    name: z.string(),
    provider: providerSchema,
    durationValue: z.number().int(),
    durationUnit: durationUnitSchema,
    replacementDays: z.number().int().nullable(),
    terms: z.string().nullable(),
  }),
}).openapi("WarrantyClaim");

export function presentStaffClaim(claim: StaffWarrantyClaim, now = Math.floor(Date.now() / 1000)) {
  return {
    ...claim,
    createdAt: isoFromSeconds(claim.createdAt),
    updatedAt: isoFromSeconds(claim.updatedAt),
    closedAt: isoOrNull(claim.closedAt),
    warranty: {
      ...claim.warranty,
      startsAt: isoFromSeconds(claim.warranty.startsAt),
      expiresAt: isoFromSeconds(claim.warranty.expiresAt),
      replacementUntil: isoOrNull(claim.warranty.replacementUntil),
      voidedAt: isoOrNull(claim.warranty.voidedAt),
      active: claim.warranty.voidedAt === null && claim.warranty.expiresAt > now,
    },
  };
}

export const staffClaimUpdateBodySchema = z.object({
  version: z.number().int().positive(),
  status: claimStatusSchema,
  resolution: claimResolutionSchema.nullable().optional().openapi({ description: "Required to resolve" }),
  message: z.string().max(CONVERSATION_LIMITS.bodyLength * 2).nullable().optional()
    .openapi({ description: "Optional public reply to the buyer, posted with the status change (notifies them)" }),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
}).strict();

export const staffOpenClaimBodySchema = z.object({
  warrantyId: warrantyIdSchema,
  description: z.string().max(CONVERSATION_LIMITS.bodyLength * 2)
    .openapi({ description: "What the buyer reported; posted as a public message from the store" }),
  quantity: z.number().int().positive().optional(),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
}).strict();

// ─── Buyer ───────────────────────────────────────────────────────────────

const lineClaimSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  status: claimStatusSchema,
  resolution: claimResolutionSchema.nullable(),
});

export const buyerWarrantySchema = z.object({
  warrantyId: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  orderItemId: z.string(),
  productId: z.string().nullable(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  imageUrl: z.string().nullable(),
  policyName: z.string(),
  provider: providerSchema,
  durationValue: z.number().int(),
  durationUnit: durationUnitSchema,
  replacementDays: z.number().int().nullable(),
  terms: z.string().nullable(),
  quantity: z.number().int(),
  startsAt: isoTimestamp,
  expiresAt: isoTimestamp,
  replacementUntil: isoTimestamp.nullable(),
  state: z.enum(["active", "expired", "voided"]),
  claim: lineClaimSchema.nullable().openapi({ description: "The latest claim (an open one first)" }),
}).openapi("BuyerWarranty");

export function presentBuyerWarranty(
  warranty: BuyerWarranty,
  imageUrl: (objectKey: string) => string,
) {
  const { imageObjectKey, voided: _voided, openClaimId: _openClaimId, ...rest } = warranty;
  return {
    ...rest,
    imageUrl: imageObjectKey ? imageUrl(imageObjectKey) : null,
    startsAt: isoFromSeconds(warranty.startsAt),
    expiresAt: isoFromSeconds(warranty.expiresAt),
    replacementUntil: isoOrNull(warranty.replacementUntil),
  };
}

export const claimClientKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)
  .openapi({ description: "One key per claim form (a UUID); a replay returns the claim it opened" });

export const buyerOpenClaimBodySchema = z.object({
  description: z.string().max(CONVERSATION_LIMITS.bodyLength * 2),
  clientKey: claimClientKeySchema,
  attachmentIds: z.array(conversationAttachmentIdSchema).max(CONVERSATION_LIMITS.attachmentsPerMessage).optional()
    .openapi({ description: "Photos staged for this claim form with claim-attachments" }),
  quantity: z.number().int().positive().optional(),
}).strict();

export const openedClaimSchema = z.object({
  claimId: z.string(),
  conversationId: z.string(),
  orderId: z.string(),
  status: claimStatusSchema,
  created: z.boolean().openapi({ description: "False when the client key replayed an earlier submit" }),
}).openapi("OpenedWarrantyClaim");

export const claimAttachmentUploadRequest = {
  content: {
    "multipart/form-data": {
      schema: z.object({
        file: z.any().openapi({ type: "string", format: "binary", description: "JPEG, PNG or WebP, 5 MB or less" }),
        clientKey: claimClientKeySchema,
      }),
    },
  },
};

export const buyerClaimSchema = z.object({
  id: z.string(),
  warrantyId: z.string(),
  orderId: z.string(),
  orderItemId: z.string(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  status: claimStatusSchema,
  resolution: claimResolutionSchema.nullable(),
  createdAt: isoTimestamp,
  closedAt: isoTimestamp.nullable(),
}).openapi("BuyerWarrantyClaim");
