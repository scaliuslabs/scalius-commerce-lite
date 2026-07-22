import type {
  CollectionProductOptionDto,
  CollectionProductOptionsPayload,
} from "./api-functions/collections";

interface PaginationFallback {
  page: number;
  limit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isCollectionProductId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("prod_");
}

export function isCollectionProductOptionDto(
  value: unknown,
): value is CollectionProductOptionDto {
  if (!isRecord(value)) return false;
  return (
    isCollectionProductId(value.id) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
    (value.categoryId === null || typeof value.categoryId === "string") &&
    (value.categoryName === null || typeof value.categoryName === "string") &&
    typeof value.isActive === "boolean" &&
    (value.primaryImage === null || typeof value.primaryImage === "string")
  );
}

function emptyPayload({
  page,
  limit,
}: PaginationFallback): CollectionProductOptionsPayload {
  return {
    products: [],
    pagination: { page, limit, total: 0, totalPages: 0 },
  };
}

/**
 * Fail closed when a lookup response is not the exact product-picker DTO.
 * This prevents a stale or colliding category response from becoming manual
 * collection membership.
 */
export function normalizeCollectionProductOptionsPayload(
  payload: unknown,
  fallback: PaginationFallback,
): CollectionProductOptionsPayload {
  if (!isRecord(payload) || !Array.isArray(payload.products)) {
    return emptyPayload(fallback);
  }
  if (!payload.products.every(isCollectionProductOptionDto)) {
    return emptyPayload(fallback);
  }

  const pagination = payload.pagination;
  if (
    !isRecord(pagination) ||
    !isNonNegativeInteger(pagination.total) ||
    !isNonNegativeInteger(pagination.totalPages) ||
    typeof pagination.page !== "number" ||
    !Number.isInteger(pagination.page) ||
    pagination.page < 1 ||
    typeof pagination.limit !== "number" ||
    !Number.isInteger(pagination.limit) ||
    pagination.limit < 1
  ) {
    return emptyPayload(fallback);
  }

  return {
    products: payload.products,
    pagination: {
      total: Number(pagination.total),
      totalPages: Number(pagination.totalPages),
      page: Number(pagination.page),
      limit: Number(pagination.limit),
    },
  };
}
