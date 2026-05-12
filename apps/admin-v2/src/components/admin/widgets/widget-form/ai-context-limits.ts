import {
  GENERATION_CONFIG,
  getMaxImages,
} from "@scalius/core/modules/ai/ai-config";

export const AI_CONTEXT_LIMITS = {
  maxImages: GENERATION_CONFIG.context.maxImages,
  maxProducts: GENERATION_CONFIG.context.maxProducts,
  maxCategories: GENERATION_CONFIG.context.maxCategories,
  maxCollections: GENERATION_CONFIG.context.maxCollections,
} as const;

export function getEffectiveImageLimit(modelId?: string, maxImagesOverride?: number): number {
  const modelLimit = typeof maxImagesOverride === "number" && Number.isFinite(maxImagesOverride)
    ? maxImagesOverride
    : modelId
      ? getMaxImages(modelId)
      : AI_CONTEXT_LIMITS.maxImages;
  return Math.min(modelLimit, AI_CONTEXT_LIMITS.maxImages);
}

export function limitImagesForModel<T>(
  images: readonly T[],
  modelId?: string,
  maxImagesOverride?: number,
): { images: T[]; limit: number; truncated: number } {
  const limit = getEffectiveImageLimit(modelId, maxImagesOverride);
  const limitedImages = images.slice(0, limit);

  return {
    images: limitedImages,
    limit,
    truncated: Math.max(0, images.length - limitedImages.length),
  };
}

export function uniqueByLimit<T>(
  items: T[],
  getKey: (item: T) => string,
  limit: number,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }

  return result;
}

export function appendUniqueWithinLimit<T>(
  current: T[],
  incoming: T[],
  getKey: (item: T) => string,
  limit: number,
): { next: T[]; added: number; skipped: number } {
  const seen = new Set(current.map(getKey));
  const next = [...current];
  let added = 0;
  let skipped = 0;

  for (const item of incoming) {
    const key = getKey(item);
    if (seen.has(key)) continue;

    if (next.length >= limit) {
      skipped += 1;
      continue;
    }

    seen.add(key);
    next.push(item);
    added += 1;
  }

  return { next, added, skipped };
}
