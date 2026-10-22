/**
 * The refusals only some screens read: a product, promotion or category saved
 * over a newer revision, a taken phone. They live apart from `admin-api-error`
 * (which every screen loads) so those screens carry them and the rest do not;
 * a manual order's refusals are in `manual-order-errors.ts`.
 */
import { readAdminApiError } from "./admin-api-error";

export interface ProductRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface PromotionRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface CategoryRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface ProductMediaSkuReferenceConflict {
  affectedCount: number;
  affectedAssociationIds: string[];
  affectedSkus: Array<{ id: string; sku: string; imageId: string }>;
}

export function readProductRevisionConflict(
  error: unknown,
): ProductRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "product_revision_conflict" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

export function readPromotionRevisionConflict(
  error: unknown,
): PromotionRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "promotion_revision_conflict" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

export function readProductMediaSkuReferenceConflict(
  error: unknown,
): ProductMediaSkuReferenceConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "product_media_sku_reference_conflict" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }
  const details = parsed.details as {
    affectedCount?: unknown;
    affectedAssociationIds?: unknown;
    affectedSkus?: unknown;
  };
  if (
    typeof details.affectedCount !== "number" ||
    !Number.isInteger(details.affectedCount) ||
    details.affectedCount < 1 ||
    !Array.isArray(details.affectedAssociationIds) ||
    details.affectedAssociationIds.length > 20 ||
    !details.affectedAssociationIds.every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(details.affectedSkus) ||
    details.affectedSkus.length > 5
  ) {
    return null;
  }
  const affectedSkus = details.affectedSkus.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { id?: unknown; sku?: unknown; imageId?: unknown };
    return typeof candidate.id === "string"
      && typeof candidate.sku === "string"
      && typeof candidate.imageId === "string"
      ? [{ id: candidate.id, sku: candidate.sku, imageId: candidate.imageId }]
      : [];
  });
  if (affectedSkus.length !== details.affectedSkus.length) return null;
  return {
    affectedCount: details.affectedCount,
    affectedAssociationIds: [...details.affectedAssociationIds],
    affectedSkus,
  };
}

export function readCategoryRevisionConflict(
  error: unknown,
): CategoryRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "category_revision_conflict" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

export interface CustomerPhoneConflict {
  id: string;
  name: string;
  phone: string;
  kind: "account" | "guest" | "merchant";
}

/** The other active customer that already uses a phone (a 400 VALIDATION_ERROR on customer create/update). */
export function readCustomerPhoneConflict(error: unknown): CustomerPhoneConflict | null {
  const parsed = readAdminApiError(error);
  if (parsed?.status !== 400 || parsed.code !== "validation_error") return null;
  const customer = (parsed.details as { customer?: Record<string, unknown> } | null | undefined)?.customer;
  if (!customer || typeof customer !== "object") return null;
  const { id, name, phone, kind } = customer;
  if (typeof id !== "string" || typeof name !== "string" || typeof phone !== "string") return null;
  if (kind !== "account" && kind !== "guest" && kind !== "merchant") return null;
  return { id, name, phone, kind };
}
