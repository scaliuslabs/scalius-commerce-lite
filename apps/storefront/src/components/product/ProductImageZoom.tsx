// src/components/product/ProductImageZoom.tsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@scalius/shared/utils";

interface ProductImageZoomProps {
  initialImage: string;
  initialZoomImage?: string;
  alt: string;
  aspectRatio?: string;
}

type ProductImageChangeDetail = {
  url?: string;
  zoomUrl?: string;
};

declare global {
  interface WindowEventMap {
    "product-image-change": CustomEvent<ProductImageChangeDetail>;
  }
}

// Global image cache to persist across component updates
const preloadedImages = new Map<string, boolean>();

function preloadImage(url: string): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  if (preloadedImages.has(url)) {
    return Promise.resolve(preloadedImages.get(url) === true);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      preloadedImages.set(url, true);
      resolve(true);
    };
    img.onerror = () => {
      preloadedImages.set(url, false);
      resolve(false);
    };
    img.src = url;
  });
}

function canLoadHighResImage(): boolean {
  if (typeof navigator === "undefined") return true;
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  return (
    !connection?.saveData && (!connection || connection.effectiveType === "4g")
  );
}

export default function ProductImageZoom({
  initialImage,
  initialZoomImage,
  alt,
  aspectRatio = "aspect-square",
}: ProductImageZoomProps) {
  // Use refs for image URLs to avoid re-renders on switch
  const currentImageRef = useRef(initialImage);
  const currentZoomImageRef = useRef(initialZoomImage);
  const imageElementRef = useRef<HTMLImageElement>(null);
  const zoomBgRef = useRef<HTMLDivElement>(null);

  // State only for UI changes that need re-render
  const [isZoomed, setIsZoomed] = useState(false);
  const [isHighResLoaded, setIsHighResLoaded] = useState(false);
  const [position, setPosition] = useState({ x: 0.5, y: 0.5 });

  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const latestPosRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });

  // Generate high-res URL from Cloudflare optimized URL
  const getHighResUrl = useCallback((url: string) => {
    if (!url) return "";
    if (url.includes("/cdn-cgi/image/")) {
      return url
        .replace(/width=\d+/, "width=1600")
        .replace(/height=\d+/, "height=1600");
    }
    return url;
  }, []);

  // Get current high-res URL
  const getZoomUrl = useCallback(() => {
    return (
      currentZoomImageRef.current || getHighResUrl(currentImageRef.current)
    );
  }, [getHighResUrl]);

  const requestZoomImage = useCallback(() => {
    const zoomUrl = getZoomUrl();
    if (!zoomUrl) return;

    if (preloadedImages.get(zoomUrl)) {
      setIsHighResLoaded(true);
      if (zoomBgRef.current) {
        zoomBgRef.current.style.backgroundImage = `url('${zoomUrl}')`;
      }
      return;
    }

    if (!canLoadHighResImage()) return;

    preloadImage(zoomUrl).then((loaded) => {
      if (loaded && getZoomUrl() === zoomUrl) {
        setIsHighResLoaded(true);
        if (zoomBgRef.current) {
          zoomBgRef.current.style.backgroundImage = `url('${zoomUrl}')`;
        }
      }
    });
  }, [getZoomUrl]);

  // Keep the loaded state in sync with URL changes without forcing high-res
  // network work before the customer shows zoom intent.
  useEffect(() => {
    const zoomUrl = getZoomUrl();
    setIsHighResLoaded(!!zoomUrl && preloadedImages.get(zoomUrl) === true);
  }, [getZoomUrl]);

  // Listen for external image changes (from thumbnails/variants)
  useEffect(() => {
    const handleImageChange = (e: CustomEvent<ProductImageChangeDetail>) => {
      if (!e.detail?.url) return;

      const newUrl = e.detail.url;
      const newZoomUrl = e.detail.zoomUrl;

      // Skip if same image
      if (newUrl === currentImageRef.current) return;

      // Update refs (no re-render)
      currentImageRef.current = newUrl;
      currentZoomImageRef.current = newZoomUrl;

      // Directly update DOM for instant feedback (no React re-render)
      if (imageElementRef.current) {
        imageElementRef.current.src = newUrl;
      }

      // Check if new zoom image is already preloaded
      const zoomUrl = newZoomUrl || getHighResUrl(newUrl);
      const alreadyLoaded = preloadedImages.get(zoomUrl) === true;
      setIsHighResLoaded(alreadyLoaded);

      // Update zoom background
      if (zoomBgRef.current) {
        zoomBgRef.current.style.backgroundImage = `url('${alreadyLoaded ? zoomUrl : newUrl}')`;
      }
    };

    window.addEventListener("product-image-change", handleImageChange);
    return () => {
      window.removeEventListener("product-image-change", handleImageChange);
    };
  }, [getHighResUrl]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsZoomed(true);
    requestZoomImage();
  }, [requestZoomImage]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;

    const { left, top, width, height } =
      containerRef.current.getBoundingClientRect();

    // Calculate percentage position (0 to 1)
    const x = Math.max(0, Math.min(1, (e.clientX - left) / width));
    const y = Math.max(0, Math.min(1, (e.clientY - top) / height));

    // Throttle to animation frame
    latestPosRef.current = { x, y };
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setPosition(latestPosRef.current);
      });
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsZoomed(false);
  }, []);

  // Current URLs for rendering
  const displayUrl = currentImageRef.current;
  const zoomUrl = getZoomUrl();

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full overflow-hidden bg-white rounded-xl cursor-crosshair border border-gray-100 group",
        aspectRatio,
      )}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ contain: "layout style" }}
    >
      {/* Base Image (Always Visible) */}
      <img
        ref={imageElementRef}
        src={displayUrl}
        alt={alt}
        className={cn(
          "w-full h-full object-contain object-center transition-opacity duration-150",
          isZoomed ? "opacity-0" : "opacity-100",
        )}
        loading="eager"
        decoding="async"
      />

      {/* Zoomed View (Visible on Hover) */}
      <div
        ref={zoomBgRef}
        className={cn(
          "absolute inset-0 w-full h-full transition-opacity duration-150 pointer-events-none bg-no-repeat bg-white",
          isZoomed ? "opacity-100" : "opacity-0",
        )}
        style={{
          backgroundImage: `url('${isHighResLoaded ? zoomUrl : displayUrl}')`,
          backgroundSize: "200%",
          backgroundPosition: `${position.x * 100}% ${position.y * 100}%`,
          willChange: isZoomed ? "background-position" : "auto",
        }}
      >
        {!isHighResLoaded && isZoomed && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/5 backdrop-blur-[1px]">
            <span className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Hint Text */}
      <div className="absolute bottom-3 right-3 bg-white/80 backdrop-blur px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-sm">
        Zoom
      </div>
    </div>
  );
}
