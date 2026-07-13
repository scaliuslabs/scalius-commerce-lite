import { demoStoreManifest } from "../manifest.mjs";

function productProfile(media) {
  if (media.kind === "video") return "video";
  return media.intendedCrop === "cover" ? "product-cover" : "product-contain";
}

export function buildExpectedAssets(manifest = demoStoreManifest) {
  const products = manifest.products.flatMap((product) =>
    product.media.map((media) => ({
      logicalKey: media.logicalKey,
      owner: product.logicalKey,
      kind: media.kind,
      role: media.role,
      altText: media.altText,
      caption: media.caption ?? null,
      intendedCrop: media.intendedCrop,
      profile: productProfile(media),
    })),
  );
  const categories = manifest.categories.flatMap((category) =>
    category.media.map((media) => ({
      logicalKey: media.logicalKey,
      owner: category.logicalKey,
      kind: "image",
      role: "category",
      altText: media.altText,
      caption: null,
      intendedCrop: "cover",
      profile: "category",
    })),
  );
  const heroes = manifest.heroes.flatMap((hero) =>
    hero.media.map((media) => ({
      logicalKey: media.logicalKey,
      owner: hero.logicalKey,
      kind: "image",
      role: media.logicalKey.endsWith(":mobile") ? "hero-mobile" : "hero-desktop",
      altText: media.altText,
      caption: null,
      intendedCrop: "cover",
      profile: media.logicalKey.endsWith(":mobile") ? "hero-mobile" : "hero-desktop",
    })),
  );

  return [...products, ...categories, ...heroes].sort((left, right) =>
    left.logicalKey.localeCompare(right.logicalKey),
  );
}
