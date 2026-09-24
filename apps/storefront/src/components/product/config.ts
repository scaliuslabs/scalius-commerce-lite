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

export const DETAILS_CONFIG = {
  container: "mt-6 pt-6 border-t border-gray-200",
  spacing: "flex flex-col gap-5",

  section: {
    title: "text-sm font-medium text-gray-900 mb-2.5",
  },

  features: {
    container: "grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2",
    item: "flex items-start",
    icon: {
      size: "h-4 w-4",
      color: "text-green-600",
      spacing: "mr-2",
      shrink: "shrink-0",
      marginTop: "mt-0.5",
    },
    text: "text-sm text-gray-700",
  },

  description: {
    prose: "prose prose-sm max-w-none text-gray-700",
  },
} as const;

export const BREADCRUMBS_CONFIG = {
  container: "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 lg:py-2",
  list: "flex items-center space-x-1 lg:space-x-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] sm:text-xs",

  link: {
    default: "text-gray-500 font-medium",
    hover: "hover:text-primary transition-colors duration-200",
  },

  separator: {
    size: "h-3 w-3",
    color: "text-gray-300",
  },

  current: "text-gray-900 font-semibold truncate",
} as const;

export const RELATED_PRODUCTS_CONFIG = {
  section: {
    bg: "bg-gray-50",
    padding: "py-10 mt-6",
  },

  container: "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8",

  title: "text-xl font-bold text-gray-900 mb-6",

  grid: "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6",

  card: {
    image: {
      container:
        "aspect-square w-full overflow-hidden rounded-lg bg-gray-100 shadow-sm border border-gray-200",
      hover: "group-hover:shadow-md transition-all duration-300",
      img: "h-full w-full object-contain object-center",
      imgHover: "group-hover:scale-105 transition-all duration-300",
    },
    discountBadge: {
      position: "absolute top-2 left-2",
      style:
        "rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700",
    },
    content: {
      spacing: "mt-2 flex flex-col",
      title: "text-sm font-medium text-gray-900 line-clamp-1",
      titleHover: "group-hover:text-gray-600 transition-colors",
      priceContainer: "mt-1 flex items-center gap-1.5",
      price: "font-medium text-gray-900 text-sm",
      originalPrice: "text-xs text-gray-500 line-through",
      freeDelivery: {
        container: "mt-1 text-xs text-green-700 font-medium flex items-center",
        iconSize: "h-3 w-3 mr-0.5",
      },
    },
  },
} as const;
