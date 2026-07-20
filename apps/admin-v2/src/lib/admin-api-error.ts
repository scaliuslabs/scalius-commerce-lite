/**
 * Status-preserving error returned by the admin API transport.
 *
 * Keep this module client-safe: TanStack Start serializes server-function
 * failures before a client-side route loader observes them.
 */
export class AdminApiResponseError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "AdminApiResponseError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ProductRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface DiscountRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface PromotionRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface CheckoutFlowRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface CategoryRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface HeroSliderRevisionConflict {
  expectedRevision: number;
  currentRevision: number;
}

export interface SitePresentationRevisionConflict {
  section: "header" | "footer";
  expectedRevision: number;
  currentRevision: number | null;
}

export interface ProductMediaSkuReferenceConflict {
  affectedCount: number;
  affectedAssociationIds: string[];
  affectedSkus: Array<{ id: string; sku: string; imageId: string }>;
}

interface AdminApiErrorShape {
  status: number | null;
  code?: string;
  details?: unknown;
}

function readAdminApiError(
  value: unknown,
  seen = new Set<object>(),
): AdminApiErrorShape | null {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const candidate = value as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    code?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  const nested = readAdminApiError(candidate.cause, seen);
  for (const status of [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
  ]) {
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return {
        status,
        code:
          typeof candidate.code === "string" ? candidate.code : nested?.code,
        details: candidate.details ?? nested?.details,
      };
    }
  }

  if (typeof candidate.code === "string" || candidate.details !== undefined) {
    return {
      status: nested?.status ?? null,
      code:
        typeof candidate.code === "string" ? candidate.code : nested?.code,
      details: candidate.details ?? nested?.details,
    };
  }
  return nested;
}

export function isAdminApiNotFoundError(error: unknown): boolean {
  return readAdminApiError(error)?.status === 404;
}

export function isAdminApiConflictError(error: unknown): boolean {
  return readAdminApiError(error)?.status === 409;
}

export function readProductRevisionConflict(
  error: unknown,
): ProductRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "PRODUCT_REVISION_CONFLICT" ||
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

export function readDiscountRevisionConflict(
  error: unknown,
): DiscountRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "DISCOUNT_REVISION_CONFLICT" ||
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
    parsed.code !== "PROMOTION_REVISION_CONFLICT" ||
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

export function readCheckoutFlowRevisionConflict(
  error: unknown,
): CheckoutFlowRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "CHECKOUT_FLOW_REVISION_CONFLICT" ||
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

export function readSitePresentationRevisionConflict(
  error: unknown,
  expectedSection?: "header" | "footer",
): SitePresentationRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "SITE_PRESENTATION_REVISION_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    section?: unknown;
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    (details.section !== "header" && details.section !== "footer") ||
    (expectedSection !== undefined && details.section !== expectedSection) ||
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 0 ||
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
    section: details.section,
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
    parsed.code !== "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT" ||
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
    parsed.code !== "CATEGORY_REVISION_CONFLICT" ||
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

export function readHeroSliderRevisionConflict(
  error: unknown,
): HeroSliderRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "HERO_SLIDER_REVISION_CONFLICT" ||
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
    typeof details.currentRevision !== "number" ||
    !Number.isInteger(details.currentRevision) ||
    details.currentRevision < 1
  ) {
    return null;
  }
  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

/**
 * Converts only an authoritative API 404 to the detail-loader absence sentinel.
 * Every other failure must reach the route error boundary.
 */
export function nullForAdminApiNotFound(error: unknown): null {
  if (isAdminApiNotFoundError(error)) return null;
  throw error;
}
