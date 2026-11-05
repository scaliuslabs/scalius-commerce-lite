// The gallery's own listing app (listing-app.tsx), installed only in the
// gallery server: it answers as a bundled app does, so its skin draws the
// store's embeds through the real host. Never part of a build.
import type { StorefrontExtension } from "@scalius/shared/plugins/storefront-components";
import { BUNDLED_STOREFRONT_EXTENSIONS } from "../extensions/bundled.gen";
import type { BundledStorefrontExtension } from "../lib/extensions/loaders";

/** A fixed release: the gallery app never changes between builds. */
const RELEASE = `9a11e1${"0".repeat(58)}`;

export const GALLERY_LISTING_EXTENSION: StorefrontExtension = {
  pluginId: "gallery.listing",
  version: "1.0.0",
  source: "bundled",
  release: RELEASE,
  sections: [],
  sectionSettings: {},
  skins: [{ id: "gallery_listing", target: "listing_main", settings: [] }],
  components: [],
  islands: [],
  stylesheet: false,
  connect: [],
};

/** Adds the app to the storefront's compiled apps for this gallery process. */
export function installGalleryListingApp(): void {
  const bundled = BUNDLED_STOREFRONT_EXTENSIONS as Record<string, BundledStorefrontExtension>;
  bundled[GALLERY_LISTING_EXTENSION.pluginId] ??= {
    release: RELEASE,
    module: () => import("./listing-app") as ReturnType<BundledStorefrontExtension["module"]>,
    files: async () => ({ FILES: {} }),
  };
}
