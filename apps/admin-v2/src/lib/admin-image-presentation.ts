import type { ImageOptimizationOptions } from "@scalius/shared/image-optimizer";

/**
 * Finite admin image transforms keep large merchant uploads out of compact UI
 * without inventing a crop. Add a preset only when a new presentation geometry
 * is materially different; arbitrary per-component sizes multiply Cloudflare
 * transformation variants and cache work.
 */
export const ADMIN_IMAGE_PRESETS = {
  avatar: {
    width: 96,
    height: 96,
    quality: 82,
    fit: "cover",
    gravity: "face",
  },
  brandLogo: {
    width: 320,
    height: 160,
    quality: 85,
    fit: "scale-down",
  },
  categoryTile: {
    width: 96,
    height: 96,
    quality: 80,
    fit: "cover",
    gravity: "auto",
  },
  favicon: {
    width: 96,
    height: 96,
    quality: 85,
    fit: "scale-down",
  },
  invoiceLogo: {
    width: 480,
    height: 160,
    quality: 88,
    fit: "scale-down",
  },
  microIcon: {
    width: 48,
    height: 48,
    quality: 82,
    fit: "scale-down",
  },
  productMicro: {
    width: 64,
    height: 64,
    quality: 80,
    fit: "scale-down",
  },
} as const satisfies Record<string, ImageOptimizationOptions>;
