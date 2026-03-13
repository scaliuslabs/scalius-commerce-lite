// src/components/product/config.ts
/**
 * Product Page UI Configuration
 */

export const GALLERY_CONFIG = {
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
    // Maximum height on mobile (in vh units)
    maxHeightMobile: "55vh",
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

export const SUMMARY_CONFIG = {
  // Product title
  title: {
    mobile: "text-lg",
    desktop: "lg:text-3xl",
    weight: "font-bold",
    color: "text-gray-900",
    spacing: "leading-tight mb-2",
  },

  // Price display
  price: {
    current: {
      mobile: "text-lg",
      desktop: "lg:text-3xl",
      weight: "font-bold",
      color: "text-primary",
    },
    original: {
      mobile: "text-[10px] sm:text-xs",
      desktop: "text-xs",
      color: "text-gray-600",
      decoration: "line-through",
    },
    discount: {
      mobile: "text-[10px] sm:text-xs",
      desktop: "text-xs",
      weight: "font-semibold",
      color: "text-primary",
    },
  },

  // Stock status badge
  stockBadge: {
    padding: "px-1.5 lg:px-2 py-0.5",
    borderRadius: "rounded-full",
    fontSize: "text-[10px] lg:text-xs",
    fontWeight: "font-medium",
    iconSize: "h-2 w-2 mr-0.5 lg:mr-1",
    variants: {
      inStock: {
        bg: "bg-green-50",
        border: "border-green-200",
        text: "text-green-700",
      },
      lowStock: {
        bg: "bg-amber-50",
        border: "border-amber-200",
        text: "text-amber-700",
      },
      outOfStock: {
        bg: "bg-red-50",
        border: "border-red-200",
        text: "text-red-700",
      },
    },
  },

  // Free delivery badge
  freeDeliveryBadge: {
    bg: "bg-green-50",
    border: "border-green-200",
    text: "text-green-700",
    padding: "px-1.5 lg:px-2 py-0.5",
    fontSize: "text-[10px] lg:text-xs",
    fontWeight: "font-medium",
    iconSize: "h-2.5 w-2.5 lg:h-3 lg:w-3",
  },

  // Quantity selector
  quantity: {
    label: "text-xs lg:text-sm font-medium text-gray-900",
    button: {
      size: "h-7 w-7 lg:h-8 lg:w-8",
      border: "border border-gray-300",
      bg: "bg-white",
      hover: "hover:bg-gray-50 hover:border-gray-400",
      active: "active:bg-gray-100 active:scale-95",
      iconSize: "h-3 w-3 lg:h-3.5 lg:w-3.5",
    },
    input: {
      size: "h-7 w-10 lg:h-8 lg:w-12",
      fontSize: "text-xs lg:text-sm",
      fontWeight: "font-medium",
      border: "border-y border-gray-300",
    },
  },

  // Variant option buttons (size/color)
  variantOptions: {
    container: "flex flex-wrap gap-1.5",
    label: "text-sm font-medium text-gray-900 mb-1",
    requiredIndicator: "text-red-600",
    button: {
      height: "h-8",
      minWidth: "min-w-[2rem]",
      padding: "px-2.5",
      fontSize: "text-xs",
      fontWeight: "font-medium",
      border: "border-2 border-gray-300",
      borderRadius: "rounded-md",
      bg: "bg-white",
      shadow: "shadow-sm",
      // State styles
      hover: "hover:border-primary/60 hover:shadow-md",
      active: "active:scale-95",
      selected: "bg-primary text-white border-primary shadow-md",
      disabled: "opacity-40 line-through bg-gray-50 pointer-events-none",
      transition: "transition-all duration-200",
    },
  },

  // Action buttons (Add to Cart, Buy Now)
  actionButtons: {
    container: "grid grid-cols-2 gap-3 pt-1",
    common: {
      padding: "py-2.5 lg:py-3",
      fontSize: "text-sm",
      fontWeight: "font-medium",
      borderWidth: "border-2",
      borderRadius: "rounded-lg",
      iconSize: "h-4 w-4",
      iconSpacing: "mr-1.5",
      transition: "transition-all duration-200",
      hover: "hover:scale-[1.02]",
      active: "active:scale-[0.98]",
      disabled:
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
    },
    addToCart: {
      bg: "bg-primary/5",
      border: "border-primary",
      text: "text-primary",
      hover: "hover:bg-primary/10 hover:shadow-md",
      shadow: "shadow-sm",
    },
    buyNow: {
      bg: "bg-primary",
      border: "border-primary",
      text: "text-primary-foreground",
      hover: "hover:bg-primary/90 hover:shadow-lg",
      shadow: "shadow-md",
    },
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

export const TOAST_CONFIG = {
  container: "toast w-full px-4 py-3 rounded mb-4 flex items-center",

  variants: {
    success: {
      bg: "bg-green-100",
      border: "border border-green-200",
      text: "text-green-700",
      icon: "✓",
      duration: 3000,
    },
    error: {
      bg: "bg-red-100",
      border: "border border-red-200",
      text: "text-red-700",
      icon: "⚠",
      duration: 5000,
    },
  },

  icon: {
    spacing: "mr-2",
  },
} as const;

export const BREAKPOINTS = {
  mobile: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

export const ANIMATIONS = {
  imageFade: {
    duration: "0.2s",
    opacity: {
      start: "0.8",
      end: "1",
    },
  },

  buttonScale: {
    hover: "scale-[1.02]",
    active: "scale-[0.98]",
    normal: "scale-100",
  },

  transition: {
    fast: "transition-all duration-150",
    normal: "transition-all duration-200",
    slow: "transition-all duration-300",
  },
} as const;

/**
 * Get responsive class string
 */
export function getResponsiveClass(config: {
  mobile?: string;
  desktop?: string;
}): string {
  const classes: string[] = [];
  if (config.mobile) classes.push(config.mobile);
  if (config.desktop) classes.push(config.desktop);
  return classes.join(" ");
}

/**
 * Build stock status config
 */
export function getStockStatusConfig(totalStock: number) {
  if (totalStock > 50) {
    return {
      text: "In Stock",
      variant: SUMMARY_CONFIG.stockBadge.variants.inStock,
    };
  }
  if (totalStock > 0) {
    return {
      text: "Low Stock",
      variant: SUMMARY_CONFIG.stockBadge.variants.lowStock,
    };
  }
  return {
    text: "Out of Stock",
    variant: SUMMARY_CONFIG.stockBadge.variants.outOfStock,
  };
}

/**
 * Build full button class string
 */
export function buildButtonClasses(
  config:
    | typeof SUMMARY_CONFIG.actionButtons.addToCart
    | typeof SUMMARY_CONFIG.actionButtons.buyNow,
): string {
  const common = SUMMARY_CONFIG.actionButtons.common;
  return [
    common.padding,
    common.fontSize,
    common.fontWeight,
    common.borderWidth,
    common.borderRadius,
    common.transition,
    common.hover,
    common.active,
    common.disabled,
    config.bg,
    config.border,
    config.text,
    config.hover,
    config.shadow,
    "flex items-center justify-center",
  ].join(" ");
}
