import type { ProductVariant } from "@/lib/api";

export type CartMediaSnapshot = {
  image?: string;
  imageMediaId?: string;
};

type ProductMediaFallback = {
  imageUrl?: string | null;
  imageMediaId?: string | null;
};

function normalized(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

function completeSnapshot(
  imageUrl: string | null | undefined,
  imageMediaId: string | null | undefined,
): CartMediaSnapshot | null {
  const image = normalized(imageUrl);
  const mediaId = normalized(imageMediaId);
  return image && mediaId ? { image, imageMediaId: mediaId } : null;
}

/**
 * Cart presentation follows the buyer-resolved SKU image snapshot, not the
 * gallery item that happened to be visible when Add to Cart was clicked.
 * Keeping URL and Media identity paired also avoids an immediate server repair.
 */
export function resolveVariantCartMedia(
  variant: Pick<ProductVariant, "imageUrl" | "imageMediaId">,
  productFallback: ProductMediaFallback,
): CartMediaSnapshot {
  const variantSnapshot = completeSnapshot(
    variant.imageUrl,
    variant.imageMediaId,
  );
  if (variantSnapshot) return variantSnapshot;

  const productSnapshot = completeSnapshot(
    productFallback.imageUrl,
    productFallback.imageMediaId,
  );
  if (productSnapshot) return productSnapshot;

  const image = normalized(variant.imageUrl) ?? normalized(productFallback.imageUrl);
  return image ? { image } : {};
}
