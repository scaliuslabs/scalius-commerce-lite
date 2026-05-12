import type {
  CollectionWithProducts,
  Product,
  ProductPageData,
  SocialLink,
} from "./api";
import {
  getOptimizedImageUrl,
  type ImageOptimizationOptions,
} from "./image-optimizer";

const PRODUCT_CARD_IMAGE_OPTIONS: ImageOptimizationOptions = {
  width: 400,
  height: 400,
  quality: 80,
  format: "auto",
  fit: "contain",
};

const PRODUCT_DETAIL_IMAGE_OPTIONS: ImageOptimizationOptions = {
  width: 600,
  height: 600,
  quality: 85,
  format: "auto",
  fit: "contain",
};

const SOCIAL_ICON_IMAGE_OPTIONS: ImageOptimizationOptions = {
  width: 20,
  height: 20,
  quality: 85,
  format: "auto",
  fit: "cover",
};

function optimizeRasterUrl(
  url: string | null | undefined,
  options: ImageOptimizationOptions,
): string | null {
  if (!url) return null;
  if (url.split("?")[0]?.toLowerCase().endsWith(".svg")) return url;
  const optimized = getOptimizedImageUrl(url, options);
  return optimized || url;
}

export function withOptimizedProductCardImage<T extends Product>(product: T): T {
  const optimizedImageUrl = optimizeRasterUrl(
    product.imageUrl,
    PRODUCT_CARD_IMAGE_OPTIONS,
  );

  if (optimizedImageUrl === product.imageUrl) return product;
  return { ...product, imageUrl: optimizedImageUrl };
}

export function withOptimizedCollectionProductImages(
  collection: CollectionWithProducts,
): CollectionWithProducts {
  const products = collection.products;
  if (!products?.length) return collection;

  return {
    ...collection,
    products: products.map(withOptimizedProductCardImage),
    featuredProduct: collection.featuredProduct
      ? withOptimizedProductCardImage(collection.featuredProduct)
      : collection.featuredProduct,
  };
}

export function withOptimizedProductPageImages(
  productData: ProductPageData,
): ProductPageData {
  return {
    ...productData,
    product: withOptimizedProductCardImage(productData.product),
    images: productData.images.map((image) => ({
      ...image,
      url:
        optimizeRasterUrl(image.url, PRODUCT_DETAIL_IMAGE_OPTIONS) ||
        image.url,
    })),
    relatedProducts: productData.relatedProducts.map(
      withOptimizedProductCardImage,
    ),
  };
}

export type SerializedSocialLink = SocialLink & {
  optimizedIconUrl?: string | null;
};

export function withOptimizedSocialIcons(
  social: SocialLink[] | undefined,
): SerializedSocialLink[] {
  return (social ?? []).map((item) => {
    const optimizedIconUrl = optimizeRasterUrl(
      item.iconUrl,
      SOCIAL_ICON_IMAGE_OPTIONS,
    );

    return {
      ...item,
      iconUrl: optimizedIconUrl ?? item.iconUrl,
      optimizedIconUrl,
    };
  });
}
