// src/components/product/config.ts
/**
 * Product Page UI Configuration
 */

export const GALLERY_CONFIG = {
  // Image renditions and `sizes` per slot: ./lib/gallery-images.ts.
  // Thumbnail sizes (adjust these to change thumbnail dimensions)
  thumbnails: {
    desktop: {
      width: 96, // w-24 in Tailwind (6rem = 96px)
      height: 88, // Actual rendered height (80px image + padding/border)
      imageSize: 140,
      gap: 12, // gap-3 in Tailwind
      padding: 6, // p-1.5
      borderWidth: 1,
    },
    mobile: {
      width: 76, // w-[4.75rem]
      height: 80, // Actual rendered height
      imageSize: 130,
      gap: 8, // gap-2
      padding: 4, // p-1
      borderWidth: 1,
    },
  },

  // Main image configuration
  mainImage: {
    // Aspect ratio for main product image
    aspectRatio: "1 / 1",
    // Keep wider single-column layouts compact without shrinking normal phones.
    maxHeightMobile: "min(55vh, 24rem)",
    // Maximum height on desktop (in vh units)
    maxHeightDesktop: "calc(100vh - 6rem)",
    // Image quality settings
    quality: {
      primary: "eager", // Load first image immediately
      others: "lazy", // Lazy load other images
    },
  },

  // Scrollable gallery configuration
  scrollable: {
    // Show gradient overlays when gallery is scrollable
    showGradients: true,
    // Number of visible thumbnails before scrolling
    visibleCount: 4,
    // Gradient height
    gradientHeight: {
      top: "2rem",
      bottom: "3rem",
    },
  },

  // Zoom overlay configuration
  zoom: {
    enabled: true,
    maxWidth: "90vw",
    maxHeight: "90vh",
    backgroundColor: "bg-black/90",
    animation: "transition-all duration-300",
    cursor: "cursor-zoom-in",
  },
} as const;

